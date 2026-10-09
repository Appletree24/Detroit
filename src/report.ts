import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Evaluation, RunResult } from "./contracts";
import { digest, Evidence } from "./evidence";
import type { FrozenExperiment } from "./runner";
import type { Store } from "./store";

export const escapeHTML = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
export type ReportRow = {
  caseId: string;
  variantId: string;
  repeat: number;
  attemptId: string | null;
  status: string;
  result: RunResult | null;
  evaluation: Evaluation | null;
  error: string | null;
  initial: Record<string, string>;
  files: Record<string, string> | null;
  trace: { event: string; payload: string }[];
  cleanup: string;
};
export function renderReport(
  title: string,
  rows: ReportRow[],
  metadata: unknown,
  demo = false,
): string {
  const e = escapeHTML;
  const variants = [...new Set(rows.map((r) => r.variantId))];
  const summaries = variants
    .map((id) => {
      const selected = rows.filter((r) => r.variantId === id);
      const unresolved = selected.filter(
        (r) =>
          r.status === "not_run" ||
          r.status === "running" ||
          r.cleanup === "pending" ||
          r.cleanup === "not_started" ||
          !r.evaluation ||
          r.evaluation.status === "evaluation_error",
      ).length;
      const passes = selected.filter(
        (r) =>
          r.status !== "not_run" &&
          r.status !== "running" &&
          r.cleanup !== "pending" &&
          r.cleanup !== "not_started" &&
          r.evaluation?.status === "pass",
      ).length;
      const tokens = selected.reduce((sum, r) => sum + (r.result?.knownTokens ?? 0), 0);
      const usageComplete = selected.every((r) => r.result?.usageComplete);
      return `<tr><td>${e(id)}</td><td>${passes}/${selected.length}${unresolved ? " · provisional" : ""}</td><td>${unresolved}</td><td>${tokens}${usageComplete ? "" : " + unknown"}</td><td>unknown</td><td>${(selected.reduce((sum, r) => sum + (r.result?.elapsedMs ?? 0), 0) / 1000).toFixed(2)}s*</td></tr>`;
    })
    .join("");
  const details = rows
    .map((row) => {
      const diff = [...new Set([...Object.keys(row.initial), ...Object.keys(row.files ?? {})])]
        .map((path) => {
          const before = row.initial[path],
            after = row.files?.[path];
          if (!row.files || before === after) return "";
          return `<details><summary>${e(path)} · ${before === undefined ? "added" : after === undefined ? "deleted" : "changed"}</summary><div class="diff"><pre>${e(before ?? "(absent)")}</pre><pre>${e(after ?? "(absent)")}</pre></div></details>`;
        })
        .join("");
      return `<article><h2>${e(row.caseId)} / ${e(row.variantId)} <small>repeat ${row.repeat + 1}</small></h2>
      <p>Execution: <b>${e(row.status)}</b> · Stop: ${e(row.result?.stopReason ?? "unknown")} · Verification: <b>${e(row.evaluation?.status ?? "unscored")}</b> · Cleanup: ${e(row.cleanup)}</p>
      <p class="muted">Attempt ${e(row.attemptId ?? "not dispatched")}</p>
      ${row.error ? `<pre>${e(row.error)}</pre>` : ""}
      <ul>${row.evaluation?.checks.map((c) => `<li>${c.passed ? "✓" : "✗"} ${e(c.name)}: ${e(c.detail)}</li>`).join("") ?? ""}</ul>
      ${row.evaluation?.error ? `<pre>${e(row.evaluation.error)}</pre>` : ""}
      <details><summary>Artifact changes (before / after)</summary>${diff || "<p>No captured changes.</p>"}</details>
      <details><summary>Evidence and actual model inputs · ${row.trace.length} entries</summary>${row.trace.map((t) => `<details><summary>${e(t.event)}</summary><pre>${e(t.payload)}</pre></details>`).join("")}</details>
    </article>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Detroit · ${e(title)}</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:1200px;margin:40px auto;padding:0 24px;line-height:1.6}h1{margin-bottom:0}h2{font-size:19px}small,.muted{opacity:.65}.notice{border-left:4px solid #c38b35;padding:12px 18px;background:#aa881118}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #8885}article{padding:20px 0;border-top:1px solid #8885}details{margin:10px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;padding:12px;font-size:12px;max-height:600px;overflow:auto}.diff{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:700px){.diff{grid-template-columns:1fr}table{font-size:12px}}
  </style></head><body><h1>Detroit</h1><p>${e(title)}</p>
  <p class="notice">${demo ? "SYNTHETIC LOCAL DEMO — known fixture solutions; no sandbox isolation or model API was used. These values test the pipeline, not agent capability." : "Scripted variants use known solutions and do not measure model capability. Unresolved trials prevent a final success-rate claim. Model-driven runs are identified by their frozen configuration and evidence."}</p>
  <table><thead><tr><th>Variant</th><th>Successful / planned</th><th>Unresolved</th><th>Known tokens</th><th>Cost USD</th><th>Agent time</th></tr></thead><tbody>${summaries}</tbody></table>
  <p class="muted">* Sum of observed Harness time, excluding preparation and verification. Missing durations are not zero-duration observations. Token estimates and provider usage are separate; pricing is not configured. Conclusions are limited to the frozen tasks and conditions; no confidence intervals or generalization claims.</p>
  ${!demo && typeof metadata === "object" && metadata !== null && "scoringSelection" in metadata ? '<p class="muted">Comparison uses the original frozen scoring version. Later rescoring remains in history and is not silently mixed into this report.</p>' : ""}
  <details><summary>Frozen experiment / provenance</summary><pre>${e(JSON.stringify(metadata, null, 2))}</pre></details>${details}</body></html>`;
}

export async function writeReport(id: string, store: Store, out: string) {
  const experiment = store.experiment(id);
  const snapshot = JSON.parse(experiment.spec_json) as FrozenExperiment;
  const rows: ReportRow[] = [];
  for (const trial of store.trials(id)) {
    const attempt = store.attempts(trial.id).at(-1);
    const item = snapshot.cases.find((c) => c.id === trial.case_id)!;
    const row: ReportRow = {
      caseId: trial.case_id,
      variantId: trial.variant_id,
      repeat: trial.repeat_index,
      attemptId: attempt?.id ?? null,
      status: attempt?.status ?? "not_run",
      result: attempt?.result_json ? JSON.parse(attempt.result_json) : null,
      evaluation: null,
      error: attempt?.error ?? null,
      initial: item.files,
      files: null,
      trace: [],
      cleanup: attempt?.cleanup ?? "not_started",
    };
    if (attempt) {
      const scoringDigest = digest(
        JSON.stringify({
          item,
          verifier: snapshot.verifierDigest,
          environment: snapshot.environment,
        }),
      );
      const evaluations = store
        .evaluations(attempt.id)
        .filter((value) => value.spec_digest === scoringDigest);
      const evaluation =
        evaluations.findLast(
          (value) => (JSON.parse(value.result_json) as Evaluation).status !== "evaluation_error",
        ) ?? evaluations.at(-1);
      row.evaluation = evaluation ? JSON.parse(evaluation.result_json) : null;
      const evidence = new Evidence(join(attempt.directory, "evidence"), attempt.id);
      for (const event of evidence.events()) {
        const payload = evidence.read(event.raw_ref);
        row.trace.push({ event: `${event.source_seq} · ${event.event_type}`, payload });
        const parsed = JSON.parse(payload) as { request_ref?: string };
        if (parsed?.request_ref)
          row.trace.push({
            event: `Actual request · ${parsed.request_ref}`,
            payload: evidence.read(parsed.request_ref),
          });
      }
      const path = join(attempt.directory, "artifacts.json");
      if (existsSync(path)) {
        const manifest = JSON.parse(await readFile(path, "utf8")) as { files_ref: string };
        row.files = JSON.parse(evidence.read(manifest.files_ref));
      }
    }
    rows.push(row);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    renderReport(experiment.name, rows, {
      id,
      ...snapshot,
      scoringSelection: {
        verifierDigest: snapshot.verifierDigest,
        environment: snapshot.environment,
      },
    }),
  );
}
