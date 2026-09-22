import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  type Case,
  type DriverRequest,
  driverFrameSchema,
  type Evaluation,
  evaluationSchema,
  type RunResult,
} from "../contracts";
import { digest, Evidence } from "../evidence";
import { type ProcessResult, runProcess } from "../process";

export type CommandRunner = typeof runProcess;
export class ContainerCleanupError extends Error {}
export class Docker {
  constructor(private command: CommandRunner = runProcess) {}
  async checked(args: string[], options: Parameters<CommandRunner>[1] = {}) {
    const result = await this.command(["docker", ...args], { timeoutMs: 30_000, ...options });
    if (result.code !== 0 || result.timedOut || result.aborted || result.truncated)
      throw new Error(
        `docker ${args[0]} failed: ${result.stderr.slice(0, 2000) || result.stdout.slice(0, 2000)}`,
      );
    return result.stdout.trim();
  }
  async doctor() {
    return this.checked(["version", "--format", "{{.Server.Version}}"]);
  }
  async resolveImage(image: string) {
    return this.checked(["image", "inspect", "--format", "{{.Id}}", image]);
  }
  async remove(name: string) {
    try {
      await this.checked(["rm", "-f", name]);
      return true;
    } catch {
      try {
        const running = await this.checked([
          "ps",
          "-a",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ]);
        return running.length === 0;
      } catch {
        return false;
      }
    }
  }
  private limits(name: string, image: string, network: string, readOnly = false) {
    return [
      "create",
      "-i",
      "--init",
      "--name",
      name,
      "--label",
      "detroit.managed=1",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--user",
      "0:0",
      "--network",
      network,
      "--cap-drop=ALL",
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=CHOWN",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      ...(readOnly ? ["--read-only"] : []),
      image,
    ];
  }
  async run(options: {
    item: Case;
    request: DriverRequest;
    image: string;
    directory: string;
    bundle: string;
    signal: AbortSignal;
    apiKey?: string;
  }): Promise<{
    result: RunResult | null;
    status: string;
    error: string | null;
    cleanup: boolean;
    files: Record<string, string> | null;
  }> {
    const { item, request, directory } = options;
    const name = `detroit-a-${request.attempt_id}`;
    const staging = join(directory, "input");
    const trace = join(directory, "evidence");
    await mkdir(join(staging, "control"), { recursive: true });
    await writeFile(join(staging, "control", "driver.js"), await readFile(options.bundle));
    await writeFiles(join(staging, "workspace"), item.files);
    await mkdir(join(staging, "evidence"), { recursive: true });
    let result: RunResult | null = null,
      error: string | null = null,
      status = "error",
      cleanup = false;
    let files: Record<string, string> | null = null;
    let output: ProcessResult | null = null;
    try {
      options.signal.throwIfAborted();
      await this.checked([
        ...this.limits(
          name,
          options.image,
          request.variant.provider === "openai" ? "bridge" : "none",
        ),
        "sh",
        "-c",
        "chown -R 1000:1000 /workspace /evidence && chmod 700 /control && exec bun /control/driver.js",
      ]);
      for (const path of ["control", "workspace", "evidence"])
        await this.checked(["cp", join(staging, path), `${name}:/${path}`]);
      output = await this.command(["docker", "start", "-ai", name], {
        input: JSON.stringify({
          ...request,
          ...(options.apiKey ? { api_key: options.apiKey } : {}),
        }),
        signal: options.signal,
        timeoutMs: request.variant.budgets.deadlineMs + 10_000,
        maxBytes: 1024 * 1024,
      });
      // Stop the entire container before collecting files, including on timeout.
      await this.checked(["stop", "--time", "1", name]);
      await mkdir(trace, { recursive: true });
      await this.checked(["cp", `${name}:/evidence/.`, trace]);
      const collected = join(directory, "output");
      await mkdir(collected, { recursive: true });
      await this.checked(["cp", `${name}:/workspace/.`, collected]);
      files = await snapshotFiles(collected);
      if (options.signal.aborted) status = "cancelled";
      else if (output.timedOut) status = "timed_out";
      else {
        result = parseDriverOutput(output, request);
        status =
          result.stopReason === "cancelled"
            ? "cancelled"
            : result.stopReason === "deadline"
              ? "timed_out"
              : "finished";
      }
    } catch (err) {
      error = String(err);
      status = options.signal.aborted ? "cancelled" : "error";
    } finally {
      cleanup = await this.remove(name);
      if (!cleanup) error = `${error ?? ""} Container cleanup unconfirmed: ${name}`.trim();
    }
    const evidence = new Evidence(trace, request.attempt_id);
    evidence.emit("runner.collected", {
      result,
      status,
      error,
      cleanup,
      output,
      files_ref: files ? evidence.put(files) : null,
    });
    return { result, status, error, cleanup, files };
  }
  async verify(options: {
    item: Case;
    files: Record<string, string>;
    image: string;
    directory: string;
    bundle: string;
    id: string;
  }): Promise<Evaluation> {
    const name = `detroit-v-${options.id}`;
    const stage = join(options.directory, "verification", options.id);
    await mkdir(join(stage, "control"), { recursive: true });
    await copyFile(options.bundle, join(stage, "control", "verifier.js"));
    await writeFile(join(stage, "control", "case.json"), JSON.stringify(options.item));
    await chmod(join(stage, "control"), 0o700);
    await writeFiles(join(stage, "workspace"), options.files);
    let result: Evaluation;
    let cleaned = false;
    try {
      await this.checked([
        ...this.limits(name, options.image, "none", true),
        "bun",
        "/control/verifier.js",
      ]);
      await this.checked(["cp", join(stage, "control"), `${name}:/control`]);
      await this.checked(["cp", join(stage, "workspace"), `${name}:/workspace`]);
      const raw = await this.checked(["start", "-ai", name], {
        timeoutMs: 15_000,
        maxBytes: 128 * 1024,
      });
      result = evaluationSchema.parse(JSON.parse(raw));
    } catch (error) {
      result = {
        version: "deterministic/1",
        status: "evaluation_error",
        checks: [],
        error: String(error),
      };
    } finally {
      cleaned = await this.remove(name);
    }
    if (!cleaned) throw new ContainerCleanupError(`Verifier cleanup unconfirmed: ${name}`);
    return result;
  }
}

export function parseDriverOutput(output: ProcessResult, request: DriverRequest): RunResult {
  if (output.code !== 0 || output.truncated || output.aborted || output.timedOut)
    throw new Error(`Driver failed: exit=${output.code}; ${output.stderr.slice(0, 1000)}`);
  const lines = output.stdout.trim().split("\n");
  if (lines.length !== 3 || lines.some((line) => line.length > 64 * 1024))
    throw new Error("Invalid driver frame count/size");
  const frames = lines.map((line) => driverFrameSchema.parse(JSON.parse(line)));
  const [ready, accepted, done] = frames;
  if (ready?.type !== "ready" || accepted?.type !== "accepted" || done?.type !== "done")
    throw new Error("Invalid driver lifecycle");
  if (
    accepted.attempt_id !== request.attempt_id ||
    JSON.stringify(accepted.effective_config) !== JSON.stringify(request.variant)
  )
    throw new Error("Driver identity or effective configuration drift");
  return done.result;
}

export async function writeFiles(root: string, files: Record<string, string>) {
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const [path, text] of Object.entries(files)) {
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((p) => p === ".." || p === "." || p === "")
    )
      throw new Error(`Invalid artifact path: ${path}`);
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o755 });
    await writeFile(join(root, path), text, { mode: 0o644 });
  }
}
export async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0,
    count = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > 2000) throw new Error("Artifact file limit exceeded");
      const path = join(dir, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error("Symlinks and special artifacts are unsupported in M1");
      if (stat.isDirectory()) await walk(path);
      else {
        bytes += stat.size;
        if (stat.size > 1024 * 1024 || bytes > 8 * 1024 * 1024)
          throw new Error("Artifact byte limit exceeded");
        const buffer = await readFile(path);
        const text = buffer.toString("utf8");
        if (!buffer.equals(Buffer.from(text)))
          throw new Error("Binary artifacts are unsupported in M1");
        files[relative(root, path)] = text;
      }
    }
  };
  await walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export const artifactDigest = (files: Record<string, string>) => digest(JSON.stringify(files));
