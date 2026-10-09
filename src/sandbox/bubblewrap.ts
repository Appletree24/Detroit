import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { arch, homedir, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Case, DriverConfiguration, DriverRequest, Evaluation, RunResult } from "../contracts";
import { candidateInput, evaluationError, judge } from "../eval/verifier";
import { digest, Evidence } from "../evidence";
import { type ProcessResult, runProcess } from "../process";
import { type CollectionMetadata, parseDriverOutput, snapshotFiles, writeFiles } from "./files";
import { launchSandbox, removeSandbox, SandboxCleanupError } from "./lifecycle";

export const sandboxPolicy = "bubblewrap/1";
export type SandboxEnvironment = {
  kind: "bubblewrap";
  policy: string;
  bubblewrap: string;
  bubblewrapDigest: string;
  bun: string;
  bunDigest: string;
  prlimitDigest: string;
  kernel: string;
  arch: string;
  osReleaseDigest: string | null;
  packagesDigest: string | null;
  limits: {
    tmpBytes: number;
    fileBytes: number;
    openFilesPerProcess: number;
    aggregateMemory: null;
    aggregateCPU: null;
    aggregatePids: null;
    workspaceQuota: null;
  };
};

export class Bubblewrap {
  private readonly bun = realpathSync(process.execPath);
  private readonly bwrap: string;
  private readonly prlimit: string;
  private readonly omp: string | null;
  private readonly ompNatives: string | null;
  constructor(options: { bwrap?: string } = {}) {
    this.bwrap = options.bwrap ?? Bun.which("bwrap") ?? "/usr/bin/bwrap";
    this.prlimit = Bun.which("prlimit") ?? "/usr/bin/prlimit";
    this.omp = Bun.which("omp") ? realpathSync(Bun.which("omp")!) : null;
    // OMP extracts its pi_natives addon to ~/.omp/natives. We bind that
    // read-only instead of extracting inside the 64 MiB /tmp at every run.
    const natives = process.env.DETROIT_OMP_NATIVES ?? join(homedir(), ".omp", "natives");
    this.ompNatives = this.omp && existsSync(natives) ? natives : null;
  }

  // Selective mounts, never the host root or home. /usr is host tooling, not an
  // immutable image; doctor fingerprints the runtime and package inventory.
  command(options: {
    workspace: string;
    bundle: string;
    network: "none" | "host";
    readOnly?: boolean;
    evidence?: string;
  }) {
    const args = [
      this.prlimit,
      "--core=0:0",
      "--fsize=16777216:16777216",
      "--nofile=256:256",
      "--",
      this.bwrap,
      "--unshare-user",
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      ...(options.network === "none" ? ["--unshare-net"] : []),
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
    ];
    for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
      if (!existsSync(path)) continue;
      args.push(
        ...(lstatSync(path).isSymbolicLink()
          ? ["--symlink", readlinkSync(path), path]
          : ["--ro-bind", path, path]),
      );
    }
    for (const path of [
      "/etc/ld.so.cache",
      ...(options.network === "host"
        ? ["/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]
        : []),
    ]) {
      if (existsSync(path)) args.push("--ro-bind", realpathSync(path), path);
    }
    args.push(
      "--ro-bind",
      this.bun,
      "/runtime/bun",
      ...(this.omp ? ["--ro-bind", this.omp, "/runtime/omp"] : []),
      "--ro-bind",
      resolve(options.bundle),
      "/control/program.js",
      options.readOnly ? "--ro-bind" : "--bind",
      resolve(options.workspace),
      "/workspace",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      // Dest is under the /tmp tmpfs, so this bind must come after that mount.
      ...(this.ompNatives ? ["--ro-bind", this.ompNatives, "/tmp/.omp/natives"] : []),
      "--setenv",
      "PATH",
      "/runtime:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "LANG",
      "C.UTF-8",
    );
    if (options.evidence) args.push("--bind", resolve(options.evidence), "/evidence");
    args.push(
      "--remount-ro",
      "/",
      "--chdir",
      "/workspace",
      "--",
      "/runtime/bun",
      "/control/program.js",
    );
    return args;
  }

  async doctor(): Promise<SandboxEnvironment> {
    if (process.platform !== "linux") throw new Error("Bubblewrap requires Linux");
    const version = await runProcess([this.bwrap, "--version"]);
    if (version.code !== 0) throw new Error(`Bubblewrap unavailable: ${version.stderr}`);
    // A version string does not prove user namespaces are allowed. Exercise the
    // same mounts, resource limits and runtime used by real attempts.
    const directory = await mkdtemp(join(tmpdir(), "detroit-doctor-"));
    try {
      await writeFiles(directory, {
        "probe.js": "if(process.getuid()!==1000)throw Error('uid');console.log('detroit-ready')",
        "workspace/.probe": "",
      });
      const probe = await launchSandbox(
        this.command({
          workspace: join(directory, "workspace"),
          bundle: join(directory, "probe.js"),
          network: "none",
        }),
        directory,
        "agent",
        { timeoutMs: 5000, env: { PATH: "/usr/bin:/bin" } },
      );
      if (probe.code !== 0 || probe.stdout.trim() !== "detroit-ready")
        throw new Error(`Bubblewrap runtime probe failed: ${probe.stderr.slice(0, 2000)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const optionalDigest = async (path: string) =>
      existsSync(path) ? digest(await readFile(path)) : null;
    return {
      kind: "bubblewrap",
      policy: sandboxPolicy,
      bubblewrap: version.stdout.trim(),
      bubblewrapDigest: digest(await readFile(this.bwrap)),
      bun: Bun.version,
      bunDigest: digest(await readFile(this.bun)),
      prlimitDigest: digest(await readFile(this.prlimit)),
      kernel: release(),
      arch: arch(),
      osReleaseDigest: await optionalDigest("/etc/os-release"),
      packagesDigest: await optionalDigest("/var/lib/dpkg/status"),
      limits: {
        tmpBytes: 64 * 1024 * 1024,
        fileBytes: 16 * 1024 * 1024,
        openFilesPerProcess: 256,
        aggregateMemory: null,
        aggregateCPU: null,
        aggregatePids: null,
        workspaceQuota: null,
      },
    };
  }

  remove(directory: string, role: "agent" | "verifier") {
    return removeSandbox(directory, role);
  }

  async run(options: {
    item: Case;
    request: DriverRequest;
    network: "none" | "host";
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
    collection?: {
      workspace: CollectionMetadata;
      trace: CollectionMetadata;
      stdoutTruncated: boolean;
    };
    collectionError?: string | null;
    configuration?: DriverConfiguration | null;
  }> {
    const { item, request, directory } = options;
    const staging = join(directory, "input");
    const trace = join(directory, "evidence");
    const rawTrace = join(staging, "evidence");
    let result: RunResult | null = null,
      error: string | null = null,
      status = "error",
      cleanup = false;
    let files: Record<string, string> | null = null;
    let configuration: DriverConfiguration | null = null;
    const collection = {
      workspace: {
        complete: false,
        truncated: false,
        missing: ["Workspace not collected"],
      } as CollectionMetadata,
      trace: {
        complete: false,
        truncated: false,
        missing: ["Trace not collected"],
      } as CollectionMetadata,
      stdoutTruncated: false,
    };
    let output: ProcessResult | null = null;
    try {
      await mkdir(staging, { recursive: true });
      await copyFile(options.bundle, join(staging, "driver.js"));
      await writeFiles(join(staging, "workspace"), item.files);
      await mkdir(rawTrace, { recursive: true });
      options.signal.throwIfAborted();
      if (request.variant.provider === "openai" && options.network !== "host")
        throw new Error("OpenAI requires explicit sandbox.network=host");
      output = await launchSandbox(
        this.command({
          workspace: join(staging, "workspace"),
          bundle: join(staging, "driver.js"),
          network: options.network,
          evidence: rawTrace,
        }),
        directory,
        "agent",
        {
          input: JSON.stringify({
            ...request,
            ...(options.apiKey ? { api_key: options.apiKey } : {}),
          }),
          signal: options.signal,
          timeoutMs: request.variant.budgets.deadlineMs + 1000,
          maxBytes: 1024 * 1024,
          env: { PATH: "/usr/bin:/bin" },
        },
      );
      // Determine the execution cause before touching artifacts. A failed
      // collection must not rewrite a deadline or cancellation as a launch error.
      collection.stdoutTruncated = output.truncated;
      if (output.aborted) status = "cancelled";
      else if (output.timedOut) status = "timed_out";
      else if (options.signal.aborted) status = "cancelled";
      else {
        result = parseDriverOutput(output, request, (observed) => {
          configuration = observed;
        });
        status =
          result.stopReason === "cancelled"
            ? "cancelled"
            : result.stopReason === "deadline"
              ? "timed_out"
              : result.stopReason === "final_response"
                ? "finished"
                : result.stopReason === "budget"
                  ? "budget"
                  : "error";
      }
    } catch (err) {
      error = String(err);
      if (!output) status = options.signal.aborted ? "cancelled" : "error";
    } finally {
      cleanup = await this.remove(directory, "agent");
      if (!cleanup) error = `${error ?? ""} Sandbox cleanup unconfirmed: ${directory}`.trim();
    }
    if (!cleanup)
      return {
        result,
        status,
        error,
        cleanup,
        files: null,
        configuration,
        collection,
        collectionError: "Cleanup unconfirmed; artifacts were not collected",
      };
    // Only confirmed-stopped workspaces may be collected. Retain safe files even
    // when another artifact is oversized, binary, unreadable or a symlink.
    if (output) {
      const traceFiles = await snapshotFiles(
        rawTrace,
        {
          entries: 20_000,
          fileBytes: 16 * 1024 * 1024,
          totalBytes: 64 * 1024 * 1024,
        },
        collection.trace,
      );
      try {
        await writeFiles(trace, traceFiles, 0o600);
      } catch (err) {
        collection.trace.complete = false;
        collection.trace.missing.push(`Evidence persistence failed: ${String(err)}`);
      }
      files = await snapshotFiles(join(staging, "workspace"), undefined, collection.workspace);
    }
    if (result?.evidenceComplete === false) {
      collection.trace.complete = false;
      collection.trace.missing.push("Driver reported incomplete execution evidence");
    }
    let evidence: Evidence;
    try {
      evidence = new Evidence(trace, request.attempt_id);
    } catch (err) {
      collection.trace.complete = false;
      collection.trace.missing.push(`Invalid or incomplete evidence journal: ${String(err)}`);
      const journal = join(trace, "events.jsonl");
      if (existsSync(journal)) await rename(journal, join(directory, "unvalidated-events.jsonl"));
      evidence = new Evidence(trace, request.attempt_id);
    }
    const collectionError =
      [...collection.workspace.missing, ...collection.trace.missing].join("; ") || null;
    evidence.emit("runner.collected", {
      result,
      status,
      error,
      cleanup,
      output,
      configuration,
      collection,
      collectionError,
      files_ref: files ? evidence.put(files) : null,
    });
    return { result, status, error, cleanup, files, collection, collectionError, configuration };
  }

  async verify(options: {
    item: Case;
    files: Record<string, string>;
    directory: string;
    bundle: string;
    id: string;
    signal?: AbortSignal;
  }): Promise<Evaluation> {
    const stage = join(options.directory, "verification", options.id);
    let result: Evaluation;
    try {
      if (!(await this.remove(options.directory, "verifier")))
        throw new SandboxCleanupError(`Verifier cleanup unconfirmed: ${options.directory}`);
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      await copyFile(options.bundle, join(stage, "worker.js"));
      await writeFiles(join(stage, "workspace"), options.files);
      const output = await launchSandbox(
        this.command({
          workspace: join(stage, "workspace"),
          bundle: join(stage, "worker.js"),
          network: "none",
          readOnly: true,
        }),
        options.directory,
        "verifier",
        {
          input: candidateInput(options.item, "/workspace"),
          timeoutMs: 5000,
          maxBytes: 64 * 1024,
          signal: options.signal,
          env: { PATH: "/usr/bin:/bin" },
        },
      );
      result = judge(options.item, output);
    } catch (error) {
      result = evaluationError(error);
    }
    if (!(await this.remove(options.directory, "verifier")))
      throw new SandboxCleanupError(`Verifier cleanup unconfirmed: ${options.directory}`);
    return result;
  }
}
