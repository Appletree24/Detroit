import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../src/cases";
import { type Evaluation, experimentSchema, type RunResult } from "../src/contracts";
import { digest } from "../src/evidence";
import { type ReportRow, renderReport, writeReport } from "../src/report";
import { schedule } from "../src/runner";
import { Store } from "../src/store";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const passing: Evaluation = {
  version: "deterministic/1",
  status: "pass",
  checks: [{ name: "output", passed: true, detail: "Correct output" }],
  error: null,
};
const result: RunResult = {
  stopReason: "deadline",
  modelCalls: 1,
  toolCalls: 0,
  knownTokens: 0,
  usageComplete: false,
  costUSD: null,
  elapsedMs: 20,
};
const row: ReportRow = {
  caseId: "case",
  variantId: "candidate",
  repeat: 0,
  attemptId: "attempt",
  status: "timed_out",
  result,
  evaluation: passing,
  error: null,
  initial: {},
  files: {},
  trace: [],
  cleanup: "done",
};

test("a stopped timeout with passing artifacts counts as successful without an implicit deadline rule", () => {
  const html = renderReport("timeout", [row], {});
  const summary = html.match(/<tbody>(.*?)<\/tbody>/s)![1]!;
  expect(summary).toContain("<td>1/1</td><td>0</td>");
});

test("an unconfirmed cleanup keeps a passing artifact unresolved", () => {
  const html = renderReport("cleanup", [{ ...row, cleanup: "pending" }], {});
  const summary = html.match(/<tbody>(.*?)<\/tbody>/s)![1]!;
  expect(summary).toContain("<td>0/1 · provisional</td><td>1</td>");
});

test("report comparison retains frozen scoring versions when only some cases have been rescored", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-report-regression-"));
  directories.push(root);
  const store = new Store(root);
  try {
    const items = cases.slice(0, 2);
    const spec = experimentSchema.parse({
      name: "versioned",
      cases: items.map((item) => item.id),
      variants: [{ id: "candidate", provider: "scripted-noop" }],
    });
    const environment = { kind: "bubblewrap", policy: "test-environment" };
    const snapshot = { spec, cases: items, environment, verifierDigest: "frozen-verifier" };
    const trials = schedule("experiment", spec);
    store.freeze("experiment", spec, snapshot, trials);
    for (const [index, trial] of trials.entries()) {
      const id = `attempt-${index}`,
        item = items.find((value) => value.id === trial.case_id)!;
      store.start(id, trial.id, join(root, id));
      store.finish(id, "finished", { ...result, stopReason: "final_response" }, null, "done");
      const scoringDigest = digest(
        JSON.stringify({ item, verifier: snapshot.verifierDigest, environment }),
      );
      store.score(id, "evidence", scoringDigest, {
        ...passing,
        status: "fail",
        checks: [{ name: "original", passed: false, detail: "Frozen rules reject output" }],
      });
      if (index === 0) store.score(id, "evidence", "new-rules", passing);
    }
    const out = join(root, "report.html");
    await writeReport("experiment", store, out);
    const html = await readFile(out, "utf8");
    expect(html.match(/<tbody>(.*?)<\/tbody>/s)![1]!).toContain("<td>0/2</td><td>0</td>");
    expect(store.evaluations("attempt-0")).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("a later same-version scoring error does not replace a valid result; error-only trials stay unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-report-error-"));
  directories.push(root);
  const store = new Store(root);
  try {
    const item = cases[0]!;
    const spec = experimentSchema.parse({
      name: "scoring-error",
      cases: [item.id],
      repeats: 2,
      variants: [{ id: "candidate", provider: "scripted-noop" }],
    });
    const environment = { kind: "bubblewrap", policy: "test-environment" };
    const snapshot = { spec, cases: [item], environment, verifierDigest: "frozen-verifier" };
    const trials = schedule("experiment", spec);
    store.freeze("experiment", spec, snapshot, trials);
    const scoringDigest = digest(
      JSON.stringify({ item, verifier: snapshot.verifierDigest, environment }),
    );
    const scoringError: Evaluation = {
      version: "deterministic/1",
      status: "evaluation_error",
      checks: [],
      error: "Scorer unavailable",
    };
    for (const [index, trial] of trials.entries()) {
      const id = `attempt-${index}`;
      store.start(id, trial.id, join(root, id));
      store.finish(id, "finished", { ...result, stopReason: "final_response" }, null, "done");
      if (index === 0) store.score(id, "evidence", scoringDigest, passing);
      // Seed persisted history independently of the current deterministic writer's deduplication.
      store.db
        .query(
          "INSERT INTO evaluations (attempt_id,evidence_digest,spec_digest,result_json,created_at) VALUES (?,?,?,?,?)",
        )
        .run(id, "evidence", scoringDigest, JSON.stringify(scoringError), new Date().toISOString());
    }
    const out = join(root, "report.html");
    await writeReport("experiment", store, out);
    const html = await readFile(out, "utf8");
    expect(html.match(/<tbody>(.*?)<\/tbody>/s)![1]!).toContain(
      "<td>1/2 · provisional</td><td>1</td>",
    );
  } finally {
    store.close();
  }
});
