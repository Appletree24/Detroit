import { driverConfiguration, driverRequestSchema, type RunResult } from "../contracts";
import { Evidence } from "../evidence";
import { type OmpFrame, OmpFrameDecoder, ompFrames } from "./omp-rpc";

const shimVersion = "omp-shim/0.2.0";
const frame = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
frame({ type: "ready", protocol_version: 1, harness_version: shimVersion });
const raw = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const request = driverRequestSchema.parse(raw);
const configuration = driverConfiguration(request.variant);
delete configuration.applied.model; // CLI application happens only after a successful spawn.
const workspaceRoot = process.env.DETROIT_OMP_WORKSPACE ?? "/workspace";
const evidence = new Evidence(
  process.env.DETROIT_OMP_EVIDENCE ?? "/evidence",
  request.attempt_id,
  "omp",
);
const abort = new AbortController();
let external: "cancelled" | "deadline" | null = null;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    external = "cancelled";
    abort.abort();
  });
const started = Date.now();
const deadlineTimer = setTimeout(() => {
  external = "deadline";
  abort.abort();
}, request.variant.budgets.deadlineMs);
let modelCalls = 0,
  toolCalls = 0,
  knownTokens = 0,
  knownCostUSD = 0;
let evidenceBytes = 0,
  droppedEvents = 0,
  evidenceComplete = true;
const observedMessages: Record<string, true> = Object.create(null);
const observedTools: Record<string, true> = Object.create(null);
let identities = 0;
const observedUsage: Record<string, true> = Object.create(null);
let accepted = false;
function first(table: Record<string, true>, id: unknown): boolean {
  if (typeof id !== "string" || id.length > 256 || !id.length) {
    evidenceComplete = false;
    return false;
  }
  if (table[id]) return false;
  if (++identities > 100_000) throw new Error("OMP observation identity limit exceeded");
  table[id] = true;
  return true;
}
function emit(type: string, payload: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > 8192 || evidenceBytes + bytes > 2_097_152) {
    droppedEvents++;
    evidenceComplete = false;
    return;
  }
  evidenceBytes += bytes;
  evidence.emit(type, payload);
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 256) : undefined);
function observe(f: OmpFrame) {
  const summary: Record<string, unknown> = { type: f.type, id: short(f.id) };
  switch (f.type) {
    case "ready":
      Object.assign(summary, {
        protocolVersion: f.protocolVersion,
        supportedProtocolVersions: f.supportedProtocolVersions,
        maxFrameBytes: f.maxFrameBytes,
        maxReassembledFrameBytes: f.maxReassembledFrameBytes,
      });
      break;
    case "response":
      Object.assign(summary, { command: short(f.command), success: f.success });
      break;
    case "prompt_result":
      Object.assign(summary, {
        status: f.status,
        agentInvoked: f.agentInvoked,
        sessionSettled: f.sessionSettled,
      });
      break;
    case "session_settled":
    case "agent_start":
      break;
    case "agent_end":
      Object.assign(summary, {
        yielded: f.yielded,
        isTerminal: f.isTerminal,
        awaitingAsyncWork: f.awaitingAsyncWork,
      });
      break;
    case "message_start":
    case "message_end": {
      const message = record(f.message);
      Object.assign(summary, { messageId: short(f.messageId), role: short(message.role) });
      if (message.role === "assistant") {
        if (first(observedMessages, f.messageId)) modelCalls++;
        Object.assign(summary, {
          provider: short(message.provider),
          model: short(message.model),
          stopReason: short(message.stopReason),
        });
        if (f.type === "message_end" && first(observedUsage, f.messageId)) {
          const usage = record(message.usage),
            cost = record(usage.cost);
          if (finite(usage.totalTokens)) {
            knownTokens += usage.totalTokens;
            summary.reportedTokens = usage.totalTokens;
          }
          if (finite(cost.total)) {
            knownCostUSD += cost.total;
            summary.reportedCostUSD = cost.total;
          }
          configuration.observed.lastMessageModel = {
            provider: short(message.provider),
            model: short(message.model),
          };
          configuration.provenance.lastMessageModel =
            "OMP message_end; reported assistant model, not requested selector";
        }
      }
      break;
    }
    case "tool_execution_start":
      if (first(observedTools, f.toolCallId)) toolCalls++;
      Object.assign(summary, { toolCallId: short(f.toolCallId), toolName: short(f.toolName) });
      break;
    case "tool_execution_end":
      Object.assign(summary, {
        toolCallId: short(f.toolCallId),
        toolName: short(f.toolName),
        isError: f.isError,
      });
      break;
    case "auto_retry_start":
    case "auto_retry_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
      Object.assign(summary, { attempt: f.attempt, success: f.success, aborted: f.aborted });
      break;
    case "rpc_frame_error":
      evidenceComplete = false;
      break;
    default:
      return; // No raw provider frames, arguments, environment, diagnostics or credentials.
  }
  emit("omp.event", summary);
}
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/runtime:/usr/bin:/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp",
    NO_COLOR: "1",
    PI_NO_TITLE: "1",
  };
  const apiKey = typeof raw.api_key === "string" ? raw.api_key : "";
  if (apiKey) {
    // v18.8.3 docs/providers.md: explicitly provider-scoped environment credentials.
    const keyNames: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GEMINI_API_KEY",
      groq: "GROQ_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      mistral: "MISTRAL_API_KEY",
      xai: "XAI_API_KEY",
      azure: "AZURE_OPENAI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
    };
    const provider = request.variant.model.includes("/")
      ? request.variant.model.split("/", 1)[0]!
      : "";
    const name = Object.hasOwn(keyNames, provider) ? keyNames[provider] : undefined;
    if (!name) {
      emit("omp.error", {
        reason: "unsupported credential mapping; provider-qualified model required",
      });
      throw new Error(
        "OMP API key requires a provider-qualified model with a supported environment credential mapping",
      );
    }
    env[name] = apiKey;
    configuration.provenance.authentication = `Explicit request key delivered via ${name}; credential omitted from evidence`;
  }
  return env;
}
async function runOmp(): Promise<RunResult> {
  const env = childEnvironment();
  const override = process.env.DETROIT_OMP_SPAWN;
  const command: unknown = override ? JSON.parse(override) : ["/runtime/omp"];
  if (!Array.isArray(command) || !command.length || command.some((v) => typeof v !== "string"))
    throw new Error("Invalid OMP spawn command");
  command.push("--mode", "rpc", "--no-ui", "--model", request.variant.model);
  const proc = Bun.spawn(command as string[], {
    cwd: workspaceRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: abort.signal,
    killSignal: "SIGKILL",
  });
  configuration.applied.model = request.variant.model;
  // Always drain stderr concurrently, but retain no potentially secret native diagnostics.
  const stderrDrain = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (!(await reader.read()).done) {}
    } finally {
      reader.releaseLock();
    }
  })();
  const decoder = new OmpFrameDecoder();
  const frames = ompFrames(proc.stdout, decoder);
  const send = (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > decoder.maxFrameBytes)
      throw new Error("OMP input exceeds advertised physical-frame limit");
    proc.stdin.write(line);
  };
  const next = async () => {
    const step = await frames.next();
    if (step.done) throw new Error("OMP stdout closed before request completion");
    observe(step.value);
    return step.value;
  };
  const response = async (id: string, type: string, extra: Record<string, unknown> = {}) => {
    send({ id, type, ...extra });
    for (;;) {
      const f = await next();
      if (f.type === "response" && f.id === id) {
        if (f.command !== type || f.success !== true) throw new Error(`OMP ${type} failed`);
        return record(f.data);
      }
    }
  };
  try {
    const ready = await next();
    if (ready.type !== "ready" || ready.protocolVersion !== 1)
      throw new Error("Invalid OMP ready frame");
    decoder.negotiate(ready);
    await response("protocol", "negotiate_protocol", { protocolVersion: 2 });
    await response("filter", "set_event_filter", {
      events: [
        "agent_start",
        "agent_end",
        "message_start",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "auto_retry_start",
        "auto_retry_end",
        "auto_compaction_start",
        "auto_compaction_end",
      ],
    });
    const state = await response("state", "get_state");
    const model = record(state.model);
    if (typeof model.id === "string" && typeof model.provider === "string") {
      configuration.observed.model = { provider: model.provider, id: model.id };
      configuration.provenance.model =
        "OMP CLI selector applied; resolved model observed via get_state before prompt";
      configuration.unknown = configuration.unknown.filter((name) => name !== "model");
    }
    frame({ type: "accepted", attempt_id: request.attempt_id, configuration });
    accepted = true;
    send({ id: request.attempt_id, type: "prompt", message: request.instruction });
    let acknowledged = false,
      completed = false,
      settled = false,
      reason: RunResult["stopReason"] = "final_response";
    while (!completed || !settled) {
      const f = await next();
      if (f.type === "response" && f.id === request.attempt_id) {
        if (f.command !== "prompt") throw new Error("OMP prompt response correlation mismatch");
        if (f.success !== true) {
          reason = "error";
          // After admission, the request's prompt_result remains the completion authority.
          if (!acknowledged) completed = settled = true;
        } else {
          acknowledged = true;
          if (record(f.data).agentInvoked === false) completed = settled = true;
        }
      } else if (f.type === "prompt_result" && f.id === request.attempt_id) {
        if (
          !acknowledged ||
          completed ||
          !["completed", "aborted", "error"].includes(String(f.status)) ||
          typeof f.sessionSettled !== "boolean"
        )
          throw new Error("Invalid OMP prompt completion correlation");
        completed = true;
        settled = f.sessionSettled;
        if (reason !== "error")
          reason =
            f.status === "error"
              ? "error"
              : f.status === "aborted"
                ? "cancelled"
                : "final_response";
        if (f.agentInvoked === false) settled = true; // No activity means no session_settled follows.
      } else if (f.type === "session_settled" && completed) settled = true;
    }
    let finalOutput: string | undefined;
    if (reason === "final_response") {
      const last = await response("last", "get_last_assistant_text");
      if (typeof last.text === "string") {
        finalOutput = last.text;
        // Stay within Detroit's existing 64 KiB driver-line cap even after JSON escaping.
        if (Buffer.byteLength(finalOutput) > 8192) {
          finalOutput = Buffer.from(finalOutput).subarray(0, 8192).toString("utf8");
          evidenceComplete = false;
        }
      }
    }
    proc.stdin.end();
    for await (const f of frames) observe(f);
    const code = await proc.exited;
    await stderrDrain;
    if (code !== 0) reason = "error";
    return result(external ?? reason, finalOutput);
  } finally {
    proc.stdin.end();
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await frames.return(undefined);
    await proc.exited;
    await stderrDrain.catch(() => {});
  }
}
function result(stopReason: RunResult["stopReason"], finalOutput?: string): RunResult {
  return {
    stopReason,
    modelCalls,
    toolCalls,
    knownTokens,
    usageComplete: false,
    costUSD: null,
    elapsedMs: Date.now() - started,
    finalOutput,
    counterSource:
      "OMP main-session assistant message identities and tool_execution_start; observed lower bounds, excludes auxiliary/subagent requests",
    countersComplete: false,
    usageSource:
      "OMP message_end reported usage; known task partial sum, not complete provider accounting",
    evidenceComplete,
  };
}
let outcome: RunResult;
try {
  outcome = await runOmp();
} catch {
  evidenceComplete = false;
  outcome = result(external ?? "error");
} finally {
  clearTimeout(deadlineTimer);
}
if (!accepted) frame({ type: "accepted", attempt_id: request.attempt_id, configuration });
evidence.emit("omp.trace", {
  shimVersion,
  stopReason: outcome.stopReason,
  modelCalls,
  toolCalls,
  knownTokens,
  knownCostUSD,
  countersComplete: false,
  usageComplete: false,
  evidenceComplete,
  droppedEvents,
});
frame({ type: "done", result: outcome, configuration });
