import { driverConfiguration, driverRequestSchema, harnessVersion } from "../contracts";
import { Evidence } from "../evidence";
import { OpenAIModel, ScriptedModel } from "../harness/provider";
import { runHarness } from "../harness/runtime";
import { ToolExecutor } from "../harness/tools";

const frame = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
frame({ type: "ready", protocol_version: 1, harness_version: harnessVersion });
const raw = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const request = driverRequestSchema.parse(raw);
const apiKey = typeof raw.api_key === "string" ? raw.api_key : "";
// Bubblewrap starts the driver as uid/gid 1000 in its own user namespace.
const evidence = new Evidence("/evidence", request.attempt_id);
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
const configuration = driverConfiguration(request.variant);
frame({ type: "accepted", attempt_id: request.attempt_id, configuration });
const model =
  request.variant.provider === "openai"
    ? new OpenAIModel(request.variant, apiKey)
    : new ScriptedModel(request.script ?? [{ content: "Synthetic no-op.", toolCalls: [] }]);
const result = await runHarness({
  instruction: request.instruction,
  variant: request.variant,
  model,
  evidence,
  tools: new ToolExecutor("/workspace", evidence),
  signal: abort.signal,
});
frame({ type: "done", result, configuration });
