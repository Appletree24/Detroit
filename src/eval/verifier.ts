import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Case, Evaluation } from "../contracts";
import { runProcess } from "../process";

// No expected values or test source enter the candidate process. The supervisor
// asserts outside it. In Docker, candidate uid 1000 cannot read /control (0700).
const worker = `
const input = JSON.parse(await Bun.stdin.text());
try {
  const mod = await import(input.entrypoint);
  const values = [];
  for (const args of input.args) {
    const before = JSON.stringify(args);
    try {
      const value = await mod[input.exportName](...args);
      values.push({ ok: true, value, mutated: JSON.stringify(args) !== before });
    } catch (error) { values.push({ ok: false, error: String(error) }); }
  }
  process.stdout.write(JSON.stringify(values));
} catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
`;
export async function evaluate(
  item: Case,
  workspace: string,
  options: { dropPrivileges?: boolean; timeoutMs?: number } = {},
): Promise<Evaluation> {
  try {
    if (!(await stat(workspace)).isDirectory())
      throw new Error("Verifier workspace is not a directory");
    const result = await runProcess([process.execPath, "-e", worker], {
      cwd: workspace,
      input: JSON.stringify({
        entrypoint: join(workspace, item.entrypoint),
        exportName: item.exportName,
        args: item.checks.map((c) => c.args),
      }),
      timeoutMs: options.timeoutMs ?? 5000,
      maxBytes: 64 * 1024,
      env: { PATH: process.env.PATH, HOME: "/tmp" },
      ...(options.dropPrivileges ? { uid: 1000, gid: 1000 } : {}),
    });
    let actual: unknown;
    try {
      actual = JSON.parse(result.stdout);
    } catch {
      actual = null;
    }
    const valid =
      result.code === 0 &&
      !result.timedOut &&
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
  } catch (error) {
    return {
      version: "deterministic/1",
      status: "evaluation_error",
      checks: [],
      error: String(error),
    };
  }
}
