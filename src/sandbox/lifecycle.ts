import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../process";

export class SandboxCleanupError extends Error {}
type Identity = { pid: number; start: string; boot: string };
type Record = {
  kind: "bubblewrap";
  state: "starting" | "running" | "done";
  identity?: Identity;
};

function identity(pid: number): Identity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return {
      pid,
      start: fields[19]!,
      boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function save(path: string, record: Record) {
  writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
const recordPath = (directory: string, role: string) => join(directory, `${role}.process.json`);

// Records live outside all sandbox mounts. A partial launch record blocks recovery
// rather than guessing which PID to kill. start time + boot ID prevent stale PID kills.
export async function removeSandbox(directory: string, role: "agent" | "verifier") {
  const path = recordPath(directory, role);
  if (!existsSync(path)) return true;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Record;
    if (record.kind !== "bubblewrap") return false;
    if (record.state === "done") return true;
    if (record.state !== "running" || !record.identity) return false;
    const original = record.identity;
    if (
      !Number.isSafeInteger(original.pid) ||
      original.pid <= 0 ||
      typeof original.start !== "string" ||
      !/^\d+$/.test(original.start) ||
      typeof original.boot !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(original.boot)
    )
      return false;
    const matches = () => {
      const current = identity(original.pid);
      return current?.start === original.start && current.boot === original.boot;
    };
    if (matches()) {
      try {
        process.kill(original.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      for (let i = 0; i < 150 && matches(); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (matches()) return false;
    }
    save(path, { kind: "bubblewrap", state: "done" });
    return true;
  } catch {
    return false;
  }
}

export async function launchSandbox(
  command: string[],
  directory: string,
  role: "agent" | "verifier",
  options: Parameters<typeof runProcess>[1] = {},
) {
  const path = recordPath(directory, role);
  if (!(await removeSandbox(directory, role)))
    throw new SandboxCleanupError(`Previous ${role} cleanup unconfirmed: ${directory}`);
  save(path, { kind: "bubblewrap", state: "starting" });
  try {
    return await runProcess(command, {
      ...options,
      onSpawn(pid) {
        const processIdentity = identity(pid);
        save(path, {
          kind: "bubblewrap",
          state: processIdentity ? "running" : "done",
          ...(processIdentity ? { identity: processIdentity } : {}),
        });
      },
    });
  } finally {
    // runProcess resolves/rejects only after child close (or failed spawn).
    // bwrap's PID namespace and --die-with-parent terminate detached descendants.
    save(path, { kind: "bubblewrap", state: "done" });
  }
}
