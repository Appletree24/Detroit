import { constants } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type DriverConfiguration,
  type DriverRequest,
  driverFrameSchema,
  type RunResult,
} from "../contracts";
import { digest } from "../evidence";
import type { ProcessResult } from "../process";

export function parseDriverOutput(
  output: ProcessResult,
  request: DriverRequest,
  observeConfiguration?: (configuration: DriverConfiguration) => void,
): RunResult {
  if (output.code !== 0 || output.truncated || output.aborted || output.timedOut)
    throw new Error(`Driver failed: exit=${output.code}; ${output.stderr.slice(0, 1000)}`);
  const lines = output.stdout.trim().split("\n");
  if (lines.length !== 3 || lines.some((line) => line.length > 64 * 1024))
    throw new Error("Invalid driver frame count/size");
  const frames = lines.map((line) => driverFrameSchema.parse(JSON.parse(line)));
  const [ready, accepted, done] = frames;
  if (ready?.type !== "ready" || accepted?.type !== "accepted" || done?.type !== "done")
    throw new Error("Invalid driver lifecycle");
  if (accepted.attempt_id !== request.attempt_id) throw new Error("Driver identity conflict");
  const configuration = done.configuration ?? accepted.configuration;
  if (
    JSON.stringify(accepted.configuration.requested) !== JSON.stringify(request.variant) ||
    JSON.stringify(configuration.requested) !== JSON.stringify(request.variant)
  )
    throw new Error("Driver requested configuration drift");
  observeConfiguration?.(configuration);
  return done.result;
}

export async function writeFiles(root: string, files: Record<string, string>, mode = 0o644) {
  const directoryMode = mode === 0o600 ? 0o700 : 0o755;
  await mkdir(root, { recursive: true, mode: directoryMode });
  if (!(await lstat(root)).isDirectory()) throw new Error("Unsafe artifact root");
  for (const [path, text] of Object.entries(files)) {
    if (
      !path ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((p) => p === ".." || p === "." || p === "")
    )
      throw new Error(`Invalid artifact path: ${path}`);
    let parent = root;
    for (const component of path.split("/").slice(0, -1)) {
      parent = join(parent, component);
      await mkdir(parent, { recursive: true, mode: directoryMode });
      if (!(await lstat(parent)).isDirectory())
        throw new Error(`Unsafe artifact directory: ${path}`);
    }
    const handle = await open(
      join(root, path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(text);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
}

export type CollectionMetadata = { complete: boolean; truncated: boolean; missing: string[] };
export async function snapshotFiles(
  root: string,
  limits = { entries: 2000, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 },
  metadata?: CollectionMetadata,
): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  const missing: string[] = [];
  let bytes = 0,
    count = 0,
    truncated = false;
  const walk = async (directory: string): Promise<void> => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = join(directory, entry.name),
        name = relative(root, path);
      if (++count > limits.entries) {
        missing.push("Artifact file limit exceeded; remaining entries not collected");
        truncated = true;
        return;
      }
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          missing.push(`Symlinks and special artifacts are unsupported: ${name}`);
          continue;
        }
        if (stat.isDirectory()) {
          await walk(path);
          if (count > limits.entries) return;
          continue;
        }
        if (stat.size > limits.fileBytes || bytes + stat.size > limits.totalBytes) {
          missing.push(`Artifact byte limit exceeded: ${name}`);
          truncated = true;
          continue;
        }
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const checked = await handle.stat();
          if (
            !checked.isFile() ||
            checked.size !== stat.size ||
            checked.ino !== stat.ino ||
            checked.dev !== stat.dev
          ) {
            missing.push(`Artifact changed during collection: ${name}`);
            continue;
          }
          const buffer = Buffer.alloc(checked.size);
          let offset = 0;
          while (offset < buffer.length) {
            const result = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
          }
          const final = await handle.stat();
          if (
            offset !== buffer.length ||
            final.size !== checked.size ||
            final.mtimeMs !== checked.mtimeMs
          ) {
            missing.push(`Artifact changed during collection: ${name}`);
            continue;
          }
          bytes += buffer.length;
          const text = buffer.toString("utf8");
          if (!buffer.equals(Buffer.from(text))) {
            missing.push(`Binary artifacts are unsupported: ${name}`);
            continue;
          }
          files[name] = text;
        } finally {
          await handle.close();
        }
      } catch (error) {
        missing.push(`Artifact unreadable: ${name}: ${String(error)}`);
      }
    }
  };
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error("Artifact root is not a directory");
    await walk(root);
  } catch (error) {
    missing.push(`Artifact collection failed: ${String(error)}`);
  }
  if (metadata) Object.assign(metadata, { complete: missing.length === 0, truncated, missing });
  else if (missing.length) throw new Error(missing.join("; "));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export const artifactDigest = (files: Record<string, string>) => digest(JSON.stringify(files));
