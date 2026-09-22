import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Evaluation, experimentSchema } from "../src/contracts";
import { Evidence } from "../src/evidence";
import { writeReport } from "../src/report";
import { recover, rescore, runExperiment } from "../src/runner";
import { ContainerCleanupError, Docker, writeFiles } from "../src/sandbox/docker";
import { Store } from "../src/store";

// Contract simulation: no Docker commands and no candidate code executed.
class FixtureDocker extends Docker {
  agentRuns = 0;
  verifierRuns = 0;
  failCleanup = false;
  override async doctor() {
    return "test-double";
  }
  override async resolveImage() {
    return `sha256:${"0".repeat(64)}`;
  }
  override async remove() {
    return true;
  }
  override async run(options: Parameters<Docker["run"]>[0]) {
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
      cleanup: true,
      files: options.item.files,
    };
  }
  override async verify(): Promise<Evaluation> {
    this.verifierRuns++;
    if (this.failCleanup) throw new ContainerCleanupError("injected verifier cleanup failure");
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
    const docker = new FixtureDocker();
    const id = await runExperiment(spec, store, root, new AbortController().signal, docker);
    const trial = store.trials(id)[0]!;
    const attempt = store.attempts(trial.id)[0]!;
    expect(attempt.status).toBe("finished");
    expect(JSON.parse(store.evaluations(attempt.id)[0]!.result_json).status).toBe(
      "evaluation_error",
    );
    await rescore(id, store, root, docker);
    expect(store.evaluations(attempt.id)).toHaveLength(2);
    expect(docker.agentRuns).toBe(1);
    await rescore(id, store, root, docker);
    expect(docker.verifierRuns).toBe(2);
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
    const docker = new FixtureDocker();
    docker.failCleanup = true;
    await expect(
      runExperiment(spec, store, root, new AbortController().signal, docker),
    ).rejects.toThrow("Cleanup unconfirmed");
    expect(docker.agentRuns).toBe(1);
    const active = store.active();
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0]!.result_json!).modelCalls).toBe(1);
    await recover(store, docker);
    expect(store.active()).toHaveLength(0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
