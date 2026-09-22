import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, variantSchema } from "../src/contracts";
import { digest, Evidence } from "../src/evidence";
import { buildContext, validatePairs } from "../src/harness/context";
import { OpenAIModel, ScriptedModel } from "../src/harness/provider";
import { runHarness } from "../src/harness/runtime";
import { ToolExecutor } from "../src/harness/tools";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "detroit-harness-"));
  dirs.push(dir);
  const evidence = new Evidence(join(dir, "evidence"), "attempt-test");
  const tools = new ToolExecutor(dir, evidence);
  const variant = variantSchema.parse({ id: "test", provider: "scripted-repair" });
  return { dir, evidence, tools, variant };
}
const call = (id: string, name: string, args: unknown) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const live = () => new AbortController().signal;

test("context keeps raw history separate and refuses broken call/result groups", () => {
  const history: Message[] = [
    { role: "user", content: "Keep this constraint" },
    { role: "assistant", content: "", toolCalls: [call("c1", "read_file", { path: "x" })] },
    { role: "tool", callId: "c1", content: "observed" },
  ];
  const variant = variantSchema.parse({ id: "test", provider: "scripted-repair" });
  const context = buildContext(history, variant.budgets);
  context.messages.pop();
  expect(history).toHaveLength(3);
  expect(() => validatePairs(history.slice(0, 2))).toThrow("Unresolved");
  expect(() => validatePairs([{ role: "tool", callId: "missing", content: "" }])).toThrow("Orphan");
  expect(() => buildContext(history, { ...variant.budgets, contextTokens: 100 })).toThrow(
    "context_budget",
  );
});

test("stale patches are rejected and repeated call IDs never apply a write twice", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "x.txt"), "original");
  const patch = call("p1", "apply_patch", {
    path: "x.txt",
    expected_digest: digest("original"),
    old: "original",
    replacement: "next",
  });
  expect((await f.tools.execute(patch, live())).status).toBe("ok");
  expect((await f.tools.execute(patch, live())).status).toBe("ok");
  expect(await readFile(join(f.dir, "x.txt"), "utf8")).toBe("next");
  expect((await f.tools.execute({ ...patch, id: "p2" }, live())).status).toBe("error");
  await expect(f.tools.execute(call("p1", "read_file", { path: "x.txt" }), live())).rejects.toThrow(
    "reused",
  );
});

test("large output retains a bounded preview and a working raw-output read path", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "long.txt"), "a".repeat(12_000));
  const output = await f.tools.execute(call("r1", "read_file", { path: "long.txt" }), live());
  expect(output.content.length).toBeLessThan(8200);
  expect(output.content).toContain("read_artifact");
  const reread = await f.tools.execute(
    call("r2", "read_artifact", { ref: output.raw_ref, offset: 9000, length: 200 }),
    live(),
  );
  expect(JSON.parse(reread.content).text).toBe("a".repeat(200));
  const secretRef = f.evidence.putText("not a tool observation");
  expect(
    (await f.tools.execute(call("r3", "read_artifact", { ref: secretRef }), live())).status,
  ).toBe("error");
});

test("file tools reject traversal and symlink escapes", async () => {
  const f = await fixture();
  await symlink("/etc/passwd", join(f.dir, "escape"));
  expect((await f.tools.execute(call("r1", "read_file", { path: "escape" }), live())).status).toBe(
    "error",
  );
  expect(
    (await f.tools.execute(call("r2", "read_file", { path: "/etc/passwd" }), live())).status,
  ).toBe("error");
});

test("tool budgets generate terminal results for every unexecuted call", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "x"), "x");
  f.variant.budgets.toolCalls = 1;
  const model = new ScriptedModel([
    {
      content: "",
      toolCalls: [call("r1", "read_file", { path: "x" }), call("r2", "read_file", { path: "x" })],
    },
  ]);
  const result = await runHarness({ ...f, instruction: "read twice", model });
  expect(result.stopReason).toBe("budget");
  const appended = f.evidence
    .events()
    .filter((e) => e.event_type === "history.append")
    .map((e) => JSON.parse(f.evidence.read(e.raw_ref)) as Message);
  expect(() => validatePairs(appended)).not.toThrow();
  expect(result.usageComplete).toBe(false);
});

test("unknown shell side effects stop the batch without executing later writes", async () => {
  const f = await fixture();
  const model = new ScriptedModel([
    {
      content: "",
      toolCalls: [
        call("s1", "shell", { command: "printf first > first; sleep 2", timeout_ms: 30 }),
        call("s2", "shell", { command: "printf second > second" }),
      ],
    },
  ]);
  const result = await runHarness({ ...f, instruction: "fixture", model });
  expect(result.stopReason).toBe("error");
  expect(await readFile(join(f.dir, "first"), "utf8")).toBe("first");
  expect(await Bun.file(join(f.dir, "second")).exists()).toBe(false);
  expect(result.toolCalls).toBe(1);
});

test("broken model responses never reach tools and have unknown usage", async () => {
  const f = await fixture();
  const model = {
    complete: async () => {
      throw new Error("connection reset with partial tool arguments");
    },
  };
  const result = await runHarness({ ...f, instruction: "fixture", model });
  expect(result.stopReason).toBe("error");
  expect(result.toolCalls).toBe(0);
  expect(result.usageComplete).toBe(false);
  expect(f.evidence.events().filter((e) => e.event_type === "tool.started")).toHaveLength(0);
});

test("pre-cancelled runs make no model or tool calls", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await runHarness({
    ...f,
    instruction: "fixture",
    model: new ScriptedModel([]),
    signal: controller.signal,
  });
  expect(result.stopReason).toBe("cancelled");
  expect(result.modelCalls).toBe(0);
});

test("official SDK adapter captures usage, tool calls, no implicit retry or partial execution", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests++;
      const body = (await req.json()) as { stream: boolean };
      expect(body.stream).toBe(false);
      if (requests > 1) return new Response("rate limited", { status: 429 });
      return Response.json({
        id: "mock-provider-response",
        object: "chat.completion",
        created: 0,
        model: "test",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"x"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  try {
    const f = await fixture();
    const variant = {
      ...f.variant,
      provider: "openai" as const,
      baseURL: `http://127.0.0.1:${server.port}/v1`,
    };
    const model = new OpenAIModel(variant, "test-only-key");
    const request = {
      model: "test",
      messages: [] as Message[],
      tools: [],
      temperature: 0,
      max_completion_tokens: 20,
      stream: false as const,
    };
    const result = await model.complete(request, live());
    expect(result.usage).toEqual({ input: 10, output: 5, source: "provider" });
    expect(result.toolCalls[0]?.id).toBe("c1");
    await expect(model.complete(request, live())).rejects.toThrow();
    expect(requests).toBe(2);
  } finally {
    server.stop(true);
  }
});
