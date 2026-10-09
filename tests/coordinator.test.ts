import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Evaluation, experimentSchema } from "../src/contracts";
import { Evidence } from "../src/evidence";
import { runProcess } from "../src/process";
import { writeReport } from "../src/report";
import { recover, rescore, runExperiment } from "../src/runner";
import { Bubblewrap, type SandboxEnvironment } from "../src/sandbox/bubblewrap";
import { type CollectionMetadata, snapshotFiles, writeFiles } from "../src/sandbox/files";
import { SandboxCleanupError } from "../src/sandbox/lifecycle";
import { Store } from "../src/store";

// Contract simulation: no sandbox commands and no candidate code executed.
class FixtureSandbox extends Bubblewrap {
  agentRuns = 0;
  verifierRuns = 0;
  failCleanup = false;
  partialArtifacts = false;
  failAgentCleanup = false;
  override async doctor(): Promise<SandboxEnvironment> {
    return {
      kind: "bubblewrap",
      policy: "test-double",
      bubblewrap: "test-double",
      bubblewrapDigest: "fixture",
      bun: "fixture",
      bunDigest: "fixture",
      prlimitDigest: "fixture",
      kernel: "fixture",
      arch: "fixture",
      osReleaseDigest: null,
      packagesDigest: null,
      limits: {
        tmpBytes: 0,
        fileBytes: 0,
        openFilesPerProcess: 0,
        aggregateMemory: null,
        aggregateCPU: null,
        aggregatePids: null,
        workspaceQuota: null,
      },
    };
  }
  override async remove() {
    return true;
  }
  override async run(options: Parameters<Bubblewrap["run"]>[0]) {
    this.agentRuns++;
    const evidence = new Evidence(join(options.directory, "evidence"), options.request.attempt_id);
    evidence.emit("fixture.only", { synthetic: true, instruction: options.request.instruction });
    expect(JSON.stringify(options.request)).not.toContain('"checks"');
    expect(options.apiKey).toBeUndefined();
    return {
      result: {
        stopReason: "final_response" as const,
        modelCalls: 1,
        toolCalls: 0,
        knownTokens: 0,
        usageComplete: false,
        costUSD: null,
        elapsedMs: 1,
      },
      status: "finished",
      error: null,
      cleanup: !this.failAgentCleanup,
      files: this.failAgentCleanup ? null : options.item.files,
      collection: this.partialArtifacts
        ? {
            workspace: {
              complete: false,
              truncated: true,
              missing: ["Artifact byte limit exceeded: index.mjs"],
            },
            trace: { complete: true, truncated: false, missing: [] },
            stdoutTruncated: false,
          }
        : undefined,
    };
  }
  override async verify(): Promise<Evaluation> {
    this.verifierRuns++;
    if (this.failCleanup) throw new SandboxCleanupError("injected verifier cleanup failure");
    return {
      version: "deterministic/1",
      status: this.verifierRuns === 1 ? "evaluation_error" : "fail",
      checks: [],
      error: this.verifierRuns === 1 ? "injected crash" : null,
    };
  }
}

test("coordinator freezes specs, preserves evaluator failures, rescores without rerunning agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-coordinator-"));
  const store = new Store(join(root, "data"));
  try {
    await writeFiles(root, {
      "dist/reference.js": "// test double",
      "dist/verifier.js": "// test double",
    });
    const spec = experimentSchema.parse({
      name: "fixture",
      cases: ["clamp"],
      variants: [{ id: "noop", provider: "scripted-noop" }],
    });
    const sandbox = new FixtureSandbox();
    const id = await runExperiment(spec, store, root, new AbortController().signal, sandbox);
    const trial = store.trials(id)[0]!;
    const attempt = store.attempts(trial.id)[0]!;
    expect(attempt.status).toBe("finished");
    expect(JSON.parse(store.evaluations(attempt.id)[0]!.result_json).status).toBe(
      "evaluation_error",
    );
    await rescore(id, store, root, sandbox);
    expect(store.evaluations(attempt.id)).toHaveLength(2);
    expect(sandbox.agentRuns).toBe(1);
    await rescore(id, store, root, sandbox);
    expect(sandbox.verifierRuns).toBe(2);
    const report = join(root, "report.html");
    await writeReport(id, store, report);
    expect(await readFile(report, "utf8")).toContain("0/1");
    expect(store.active()).toHaveLength(0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed verifier cleanup stops dispatch and retains observed model usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-coordinator-"));
  const store = new Store(join(root, "data"));
  try {
    await writeFiles(root, {
      "dist/reference.js": "// test double",
      "dist/verifier.js": "// test double",
    });
    const spec = experimentSchema.parse({
      name: "fixture",
      cases: ["clamp", "mean"],
      variants: [{ id: "noop", provider: "scripted-noop" }],
    });
    const sandbox = new FixtureSandbox();
    sandbox.failCleanup = true;
    await expect(
      runExperiment(spec, store, root, new AbortController().signal, sandbox),
    ).rejects.toThrow("Cleanup unconfirmed");
    expect(sandbox.agentRuns).toBe(1);
    const active = store.active();
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0]!.result_json!).modelCalls).toBe(1);
    await recover(store, sandbox);
    expect(store.active()).toHaveLength(0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete artifact collection stays unknown and is never rescored as a candidate failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-partial-"));
  const store = new Store(join(root, "data"));
  try {
    await writeFiles(root, { "dist/reference.js": "// fixture", "dist/verifier.js": "// fixture" });
    const sandbox = new FixtureSandbox();
    sandbox.partialArtifacts = true;
    const id = await runExperiment(
      experimentSchema.parse({
        name: "partial",
        cases: ["clamp"],
        variants: [{ id: "noop", provider: "scripted-noop" }],
      }),
      store,
      root,
      new AbortController().signal,
      sandbox,
    );
    const attempt = store.attempts(store.trials(id)[0]!.id)[0]!;
    expect(attempt.status).toBe("finished");
    expect(JSON.parse(attempt.result_json!).modelCalls).toBe(1);
    expect(JSON.parse(store.evaluations(attempt.id)[0]!.result_json).status).toBe(
      "evaluation_error",
    );
    const manifest = JSON.parse(await readFile(join(attempt.directory, "artifacts.json"), "utf8"));
    expect(manifest.complete).toBe(false);
    expect(manifest.truncated).toBe(true);
    expect(manifest.missing).toHaveLength(1);
    await rescore(id, store, root, sandbox);
    expect(sandbox.verifierRuns).toBe(0);
    expect(store.evaluations(attempt.id)).toHaveLength(1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed agent cleanup retains usage without freezing artifacts or dispatching again", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-agent-cleanup-"));
  const store = new Store(join(root, "data"));
  try {
    await writeFiles(root, { "dist/reference.js": "// fixture", "dist/verifier.js": "// fixture" });
    const sandbox = new FixtureSandbox();
    sandbox.failAgentCleanup = true;
    await expect(
      runExperiment(
        experimentSchema.parse({
          name: "cleanup",
          cases: ["clamp", "mean"],
          variants: [{ id: "noop", provider: "scripted-noop" }],
        }),
        store,
        root,
        new AbortController().signal,
        sandbox,
      ),
    ).rejects.toThrow("Cleanup unconfirmed");
    expect(sandbox.agentRuns).toBe(1);
    expect(sandbox.verifierRuns).toBe(0);
    const attempt = store.active()[0]!;
    expect(attempt.status).toBe("finished");
    expect(JSON.parse(attempt.result_json!).modelCalls).toBe(1);
    expect(store.evaluations(attempt.id)).toHaveLength(0);
    expect(await Bun.file(join(attempt.directory, "artifacts.json")).exists()).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("partial text snapshots retain safe artifacts and disclose each excluded file", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-snapshot-"));
  try {
    await writeFiles(root, { "good.txt": "safe", "oversized.txt": "x".repeat(33) });
    await writeFile(join(root, "binary"), Buffer.from([0xff, 0xfe]));
    await symlink("/etc/passwd", join(root, "link"));
    const metadata: CollectionMetadata = { complete: true, truncated: false, missing: [] };
    const files = await snapshotFiles(
      root,
      { entries: 20, fileBytes: 32, totalBytes: 64 },
      metadata,
    );
    expect(files).toEqual({ "good.txt": "safe" });
    expect(metadata.complete).toBe(false);
    expect(metadata.truncated).toBe(true);
    expect(metadata.missing.some((reason) => reason.includes("oversized.txt"))).toBe(true);
    expect(
      metadata.missing.some((reason) => reason.includes("Binary") && reason.includes("binary")),
    ).toBe(true);
    expect(
      metadata.missing.some((reason) => reason.includes("Symlinks") && reason.includes("link")),
    ).toBe(true);
    await expect(snapshotFiles(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Native child signal/close timing cannot be advanced by this process's fake timers.
test("output-limit termination is not later relabelled as a wall timeout", async () => {
  const output = await runProcess(
    [
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(100));setInterval(()=>{},1000)",
    ],
    { maxBytes: 10, timeoutMs: 150 },
  );
  expect(output.truncated).toBe(true);
  expect(output.timedOut).toBe(false);
  expect(output.aborted).toBe(false);
  expect(output.stdout.length + output.stderr.length).toBeLessThanOrEqual(10);
});
