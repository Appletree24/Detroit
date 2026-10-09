import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Case, Evaluation } from "../contracts";
import { type ProcessResult, runProcess } from "../process";

export function candidateInput(item: Case, workspace: string) {
  return JSON.stringify({
    entrypoint: join(workspace, item.entrypoint),
    exportName: item.exportName,
    args: item.checks.map((c) => c.args),
  });
}
export function evaluationError(error: unknown): Evaluation {
  return {
    version: "deterministic/1",
    status: "evaluation_error",
    checks: [],
    error: String(error),
  };
}

// Trusted assertions execute outside the sandbox. Candidate crashes after the
// readiness marker are task failures; sandbox/runtime startup errors are separate.
export function judge(item: Case, result: ProcessResult): Evaluation {
  const marker = "DETROIT_WORKER_READY\n";
  if (!result.stdout.startsWith(marker))
    return evaluationError(`Worker did not start: ${result.stderr.slice(0, 1000)}`);
  let actual: unknown;
  try {
    actual = JSON.parse(result.stdout.slice(marker.length));
  } catch {
    actual = null;
  }
  const valid =
    result.code === 0 &&
    !result.timedOut &&
    !result.aborted &&
    !result.truncated &&
    Array.isArray(actual) &&
    actual.length === item.checks.length;
  const checks = item.checks.map((check, i) => {
    const value = valid
      ? (actual as { ok?: boolean; value?: unknown; mutated?: boolean }[])[i]
      : null;
    const passed =
      value?.ok === true &&
      value.mutated === false &&
      isDeepStrictEqual(value.value, check.expected);
    return {
      name: check.name,
      passed,
      detail: passed
        ? "Matched expected result; arguments unchanged"
        : valid
          ? `Expected ${JSON.stringify(check.expected)}, received ${JSON.stringify(value)}`
          : `Candidate failed to return valid results: exit=${result.code}, timeout=${result.timedOut}, truncated=${result.truncated}; ${result.stderr.slice(0, 1000)}`,
    };
  });
  return {
    version: "deterministic/1",
    status: checks.every((c) => c.passed) ? "pass" : "fail",
    checks,
    error: null,
  };
}

// Local execution exists only for this repository's fixed fixture unit tests.
// The production coordinator always calls Bubblewrap.verify.
export async function evaluate(
  item: Case,
  workspace: string,
  options: { timeoutMs?: number } = {},
): Promise<Evaluation> {
  try {
    if (!(await stat(workspace)).isDirectory())
      throw new Error("Verifier workspace is not a directory");
    const result = await runProcess(
      [process.execPath, join(import.meta.dir, "../drivers/verifier.ts")],
      {
        cwd: workspace,
        input: candidateInput(item, workspace),
        timeoutMs: options.timeoutMs ?? 5000,
        maxBytes: 64 * 1024,
        env: { PATH: process.env.PATH, HOME: "/tmp" },
      },
    );
    return judge(item, result);
  } catch (error) {
    return evaluationError(error);
  }
}
