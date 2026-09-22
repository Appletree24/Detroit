import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
};
export function runProcess(
  command: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxBytes?: number;
    uid?: number;
    gid?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        truncated: false,
      });
      return;
    }
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      uid: options.uid,
      gid: options.gid,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const cap = options.maxBytes ?? 1024 * 1024;
    let bytes = 0,
      timedOut = false,
      aborted = false,
      truncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 300);
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, cap - bytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        truncated = true;
        stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      // Reap descendants even if the immediate shell exited first.
      kill("SIGKILL");
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}
