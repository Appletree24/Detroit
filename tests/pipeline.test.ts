import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cases, repairScript } from "../src/cases";
import {
  type DriverRequest,
  experimentSchema,
  harnessVersion,
  variantSchema,
} from "../src/contracts";
import { evaluate } from "../src/eval/verifier";
import { digest, Evidence } from "../src/evidence";
import { ScriptedModel } from "../src/harness/provider";
import { runHarness } from "../src/harness/runtime";
import { ToolExecutor } from "../src/harness/tools";
import { escapeHTML, type ReportRow, renderReport } from "../src/report";
import { schedule } from "../src/runner";
import { Docker, parseDriverOutput, snapshotFiles, writeFiles } from "../src/sandbox/docker";
import { acquireLock, Store } from "../src/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "detroit-pipeline-"));
  dirs.push(dir);
  return dir;
}

test("evidence rejects modified objects and truncated journals", async () => {
  const dir = await fixture();
  const evidence = new Evidence(dir, "a1");
  const event = evidence.emit("test", { observed: 1 });
  expect(evidence.events()).toHaveLength(1);
  await writeFile(join(evidence.objects, event.raw_ref), '{"observed":2}');
  expect(() => evidence.events()).toThrow("digest mismatch");
  await appendFile(evidence.journal, '{"partial":');
  expect(() => evidence.events()).toThrow("Incomplete journal tail");
});

test("store enforces single writer, immutable terminal attempts and scoring conflicts", async () => {
  const dir = await fixture();
  const release = acquireLock(dir);
  expect(() => acquireLock(dir)).toThrow("coordinator");
  const store = new Store(dir);
  try {
    const spec = experimentSchema.parse({
      name: "test",
      cases: ["clamp"],
      variants: [{ id: "noop", provider: "scripted-noop" }],
    });
    const trials = schedule("e1", spec);
    store.freeze("e1", spec, spec, trials);
    store.start("a1", trials[0]!.id, "/local-fixture");
    store.finish("a1", "finished", null, null, "done");
    expect(() => store.finish("a1", "running", null, null, "done")).toThrow("terminal");
    const result = {
      version: "deterministic/1" as const,
      status: "fail" as const,
      checks: [],
      error: null,
    };
    store.score("a1", "artifact", "verifier1", result);
    store.score("a1", "artifact", "verifier1", result);
    expect(store.evaluations("a1")).toHaveLength(1);
    expect(() => store.score("a1", "artifact", "verifier1", { ...result, status: "pass" })).toThrow(
      "conflict",
    );
    store.score("a1", "artifact", "verifier2", result);
    expect(store.evaluations("a1")).toHaveLength(2);
  } finally {
    store.close();
    release();
  }
});

test("seeded scheduling retains every planned trial without duplicates", () => {
  const spec = experimentSchema.parse({
    name: "test",
    cases: ["clamp", "mean"],
    repeats: 2,
    variants: [
      { id: "a", provider: "scripted-repair" },
      { id: "b", provider: "scripted-noop" },
    ],
  });
  const first = schedule("e1", spec);
  expect(first).toEqual(schedule("e1", spec));
  expect(first).toHaveLength(8);
  expect(new Set(first.map((t) => `${t.case_id}/${t.variant_id}/${t.repeat_index}`)).size).toBe(8);
});

test("driver rejects partial frames, identity drift and config drift", () => {
  const variant = variantSchema.parse({ id: "test", provider: "scripted-noop" });
  const request: DriverRequest = {
    protocol_version: 1,
    attempt_id: "a1",
    instruction: "test",
    variant,
  };
  const frames = [
    { type: "ready", protocol_version: 1, harness_version: harnessVersion },
    { type: "accepted", attempt_id: "a1", effective_config: variant },
    {
      type: "done",
      result: {
        stopReason: "final_response",
        modelCalls: 1,
        toolCalls: 0,
        knownTokens: 0,
        usageComplete: false,
        costUSD: null,
        elapsedMs: 1,
      },
    },
  ];
  const output = {
    code: 0,
    stdout: frames.map((f) => JSON.stringify(f)).join("\n"),
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
  };
  expect(parseDriverOutput(output, request).stopReason).toBe("final_response");
  expect(() =>
    parseDriverOutput({ ...output, stdout: output.stdout.slice(0, -2) }, request),
  ).toThrow();
  expect(() => parseDriverOutput(output, { ...request, attempt_id: "other" })).toThrow("identity");
  expect(() =>
    parseDriverOutput(output, { ...request, variant: { ...variant, model: "drift" } }),
  ).toThrow("drift");
});

test("Docker failures still issue container cleanup; contract only, no daemon involved", async () => {
  const commands: string[][] = [];
  const dir = await fixture();
  const variant = variantSchema.parse({ id: "test", provider: "scripted-noop" });
  const bundle = join(dir, "driver.js");
  await writeFile(bundle, "// fixture");
  const docker = new Docker(async (command) => {
    commands.push(command);
    return {
      code: command[1] === "cp" ? 1 : 0,
      stdout: "",
      stderr: "injected cp failure",
      timedOut: false,
      aborted: false,
      truncated: false,
    };
  });
  const outcome = await docker.run({
    item: cases[0]!,
    request: { protocol_version: 1, attempt_id: "a1", instruction: "fixture", variant },
    image: "sha256:fixture",
    directory: dir,
    bundle,
    signal: new AbortController().signal,
  });
  expect(outcome.status).toBe("error");
  expect(outcome.cleanup).toBe(true);
  expect(commands.some((c) => c[1] === "rm" && c.includes("detroit-a-a1"))).toBe(true);
  expect(commands[0]).toContain("--network");
  expect(commands[0]).toContain("none");
});

test("artifact collector rejects symlinks and binaries", async () => {
  const dir = await fixture();
  await symlink("/etc/passwd", join(dir, "link"));
  await expect(snapshotFiles(dir)).rejects.toThrow("Symlinks");
  await rm(join(dir, "link"));
  await writeFile(join(dir, "binary"), Buffer.from([0xff, 0xfe]));
  await expect(snapshotFiles(dir)).rejects.toThrow("Binary");
});

test("scripted fixture to tools to independent scoring to report; explicitly local synthetic demo", async () => {
  const root = await fixture();
  const rows: ReportRow[] = [];
  for (const item of cases) {
    for (const repair of [false, true]) {
      const id = `${item.id}-${repair ? "repair" : "noop"}`;
      const dir = join(root, id);
      const workspace = join(dir, "workspace");
      await writeFiles(workspace, item.files);
      const evidence = new Evidence(join(dir, "evidence"), id);
      const variant = variantSchema.parse({
        id: repair ? "scripted-repair" : "scripted-noop",
        provider: repair ? "scripted-repair" : "scripted-noop",
      });
      const script = repair ? repairScript(item) : [{ content: "Synthetic no-op", toolCalls: [] }];
      const result = await runHarness({
        instruction: item.instruction,
        variant,
        evidence,
        tools: new ToolExecutor(workspace, evidence),
        model: new ScriptedModel(script),
      });
      const files = await snapshotFiles(workspace);
      const evaluation = await evaluate(item, workspace);
      expect(evaluation.status).toBe(repair ? "pass" : "fail");
      const trace = evidence.events().flatMap((e) => {
        const payload = evidence.read(e.raw_ref);
        const data = JSON.parse(payload);
        if (e.event_type === "tool.completed") expect(data.result.status).toBe("ok");
        return [
          { event: e.event_type, payload },
          ...(data?.request_ref
            ? [{ event: "actual model input", payload: evidence.read(data.request_ref) }]
            : []),
        ];
      });
      rows.push({
        caseId: item.id,
        variantId: variant.id,
        repeat: 0,
        attemptId: id,
        status: "finished",
        result,
        evaluation,
        error: null,
        initial: item.files,
        files,
        trace,
        cleanup: "local-test-fixture",
      });
    }
  }
  const html = renderReport(
    "M1 deterministic pipeline demonstration",
    rows,
    {
      runtime: Bun.version,
      isolation: "none: repository-owned test fixtures only",
      realModelCalls: 0,
    },
    true,
  );
  expect(html).toContain("SYNTHETIC LOCAL DEMO");
  expect(html).toContain("5/5");
  expect(html).toContain("0/5");
  expect(escapeHTML('<script>&"')).toBe("&lt;script&gt;&amp;&quot;");
  // Opt-in artifact generation is separate from normal test execution.
  if (process.env.DETROIT_WRITE_DEMO === "1") {
    const out = resolve(import.meta.dir, "../examples/reports/m1-synthetic.html");
    await writeFiles(resolve(import.meta.dir, "../examples/reports"), {
      "m1-synthetic.html": html,
    });
    expect(digest(await readFile(out))).toHaveLength(64);
  }
}, 30_000);
