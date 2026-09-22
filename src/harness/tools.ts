import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolCall } from "../contracts";
import { digest, type Evidence } from "../evidence";
import { runProcess } from "../process";

const definitions = {
  read_file: {
    description: "Read a UTF-8 workspace file and its SHA-256 digest.",
    schema: z.object({ path: z.string() }).strict(),
  },
  search: {
    description: "Find literal text in workspace files (maximum 100 matches).",
    schema: z.object({ text: z.string().min(1) }).strict(),
  },
  apply_patch: {
    description:
      "Replace exactly one literal occurrence, only when the file still has expected_digest. Read first.",
    schema: z
      .object({
        path: z.string(),
        expected_digest: z.string().regex(/^[a-f0-9]{64}$/),
        old: z.string().min(1),
        replacement: z.string(),
      })
      .strict(),
  },
  shell: {
    description:
      "Run a shell command inside the attempt container. Has side effects; never automatically retried.",
    schema: z
      .object({
        command: z.string(),
        timeout_ms: z.number().int().min(1).max(30_000).default(10_000),
      })
      .strict(),
  },
  read_artifact: {
    description: "Read a range of a prior raw tool output by SHA-256 reference.",
    schema: z
      .object({
        ref: z.string().regex(/^[a-f0-9]{64}$/),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(8000).default(4000),
      })
      .strict(),
  },
};
export const toolSchemas = Object.entries(definitions).map(([name, def]) => ({
  type: "function" as const,
  function: { name, description: def.description, parameters: z.toJSONSchema(def.schema) },
}));
export type ToolResult = {
  status: "ok" | "error" | "unknown" | "cancelled";
  content: string;
  raw_ref: string;
  code?: string;
};

export class ToolExecutor {
  private results = new Map<string, { fingerprint: string; result: ToolResult }>();
  private readableArtifacts = new Set<string>();
  constructor(
    readonly workspace: string,
    readonly evidence: Evidence,
  ) {}
  private async path(name: string) {
    if (isAbsolute(name)) throw new Error("Workspace-relative path required");
    const root = await realpath(this.workspace);
    const path = await realpath(resolve(root, name));
    const rel = relative(root, path);
    if (rel.startsWith("../") || rel === ".." || isAbsolute(rel))
      throw new Error("Path escapes workspace");
    if (!(await lstat(path)).isFile()) throw new Error("Regular file required");
    return path;
  }
  private async text(path: string) {
    if ((await lstat(path)).size > 1024 * 1024) throw new Error("File exceeds 1 MiB read limit");
    return readFile(path, "utf8");
  }
  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const fingerprint = digest(JSON.stringify({ name: call.name, arguments: call.arguments }));
    const cached = this.results.get(call.id);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new Error("Call ID reused with different arguments");
      this.evidence.emit("tool.deduplicated", { call_id: call.id });
      return cached.result;
    }
    this.evidence.emit("tool.started", {
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    let status: ToolResult["status"] = "ok",
      output = "",
      code: string | undefined;
    try {
      if (signal.aborted) {
        status = "cancelled";
        output = "Cancelled before execution";
      } else {
        const raw: unknown = JSON.parse(call.arguments);
        switch (call.name) {
          case "read_file": {
            const { path } = definitions.read_file.schema.parse(raw);
            const text = await this.text(await this.path(path));
            output = JSON.stringify({ path, digest: digest(text), text });
            break;
          }
          case "search": {
            const { text } = definitions.search.schema.parse(raw);
            const matches: unknown[] = [];
            let visited = 0;
            const walk = async (dir: string): Promise<void> => {
              for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (++visited > 2000 || matches.length >= 100) return;
                const path = join(dir, entry.name);
                if (entry.isDirectory()) await walk(path);
                else if (entry.isFile() && (await lstat(path)).size <= 1024 * 1024) {
                  const lines = (await readFile(path, "utf8")).split("\n");
                  for (const [i, line] of lines.entries()) {
                    if (line.includes(text))
                      matches.push({
                        path: relative(this.workspace, path),
                        line: i + 1,
                        text: line,
                      });
                    if (matches.length >= 100) break;
                  }
                }
              }
            };
            await walk(this.workspace);
            output = JSON.stringify({
              matches,
              scanBounded: visited > 2000 || matches.length >= 100,
            });
            break;
          }
          case "apply_patch": {
            const args = definitions.apply_patch.schema.parse(raw);
            const path = await this.path(args.path);
            const text = await this.text(path);
            if (digest(text) !== args.expected_digest)
              throw new Error("stale_digest: reread the file before patching");
            if (text.split(args.old).length !== 2) throw new Error("Patch must match exactly once");
            const next = text.replace(args.old, () => args.replacement);
            if (Buffer.byteLength(next) > 1024 * 1024)
              throw new Error("Patched file exceeds 1 MiB");
            const temp = `${path}.${randomUUID()}.tmp`;
            await writeFile(temp, next);
            await rename(temp, path);
            output = JSON.stringify({ path: args.path, digest: digest(next) });
            break;
          }
          case "shell": {
            const args = definitions.shell.schema.parse(raw);
            const result = await runProcess(["/bin/sh", "-c", args.command], {
              cwd: this.workspace,
              signal,
              timeoutMs: args.timeout_ms,
              maxBytes: 256 * 1024,
              env: { PATH: process.env.PATH, HOME: "/tmp", LANG: "C.UTF-8" },
            });
            status =
              result.timedOut || result.aborted || result.truncated
                ? "unknown"
                : result.code === 0
                  ? "ok"
                  : "error";
            output = JSON.stringify(result);
            code = status === "unknown" ? "side_effect_unknown" : undefined;
            break;
          }
          case "read_artifact": {
            const args = definitions.read_artifact.schema.parse(raw);
            if (!this.readableArtifacts.has(args.ref))
              throw new Error("Only prior tool outputs may be reread");
            const text = this.evidence.read(args.ref);
            output = JSON.stringify({
              text: text.slice(args.offset, args.offset + args.length),
              offset: args.offset,
              total: text.length,
            });
            break;
          }
          default:
            throw new Error(`Unknown tool: ${call.name}`);
        }
      }
    } catch (error) {
      status = "error";
      code = "tool_error";
      output = error instanceof Error ? error.message : String(error);
    }
    const raw_ref = this.evidence.putText(output);
    this.readableArtifacts.add(raw_ref);
    const result: ToolResult = { status, raw_ref, code, content: output.slice(0, 8000) };
    if (output.length > 8000)
      result.content += `\n[Preview truncated; read_artifact ref=${raw_ref} total=${output.length}]`;
    this.results.set(call.id, { fingerprint, result });
    this.evidence.emit("tool.completed", { call_id: call.id, result });
    return result;
  }
}
