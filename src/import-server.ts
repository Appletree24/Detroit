import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { CaseImports } from "./case-imports";
import {
  collectionInputSchema,
  collectionMemberSchema,
  importLimits,
  importPayloadSchema,
  importRequestSchema,
} from "./import-contract";
import { importCss, importHtml } from "./import-layout";
import { importJs } from "./import-ui";
import { acquireLock, Store } from "./store";

const requestLimit = importLimits.payloadBytes;

export async function serveImports(root: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("port must be 0..65535; 0 selects a free port");
  const release = acquireLock(root);
  let store: Store | undefined;
  let server: Server<undefined> | undefined;
  try {
    store = new Store(root);
    const imports = new CaseImports(store);
    const token = randomBytes(32).toString("hex");
    let origin = `http://127.0.0.1:${port}`;
    let host = `127.0.0.1:${port}`;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: requestLimit,
      async fetch(request) {
        const headers = {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        };
        const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
        try {
          if (request.headers.get("host") !== host) return json({ error: "untrusted Host" }, 403);
          const requestOrigin = request.headers.get("origin");
          if (requestOrigin && requestOrigin !== origin)
            return json({ error: "untrusted Origin" }, 403);
          const site = request.headers.get("sec-fetch-site");
          if (site && site !== "same-origin" && site !== "none")
            return json({ error: "cross-site request" }, 403);
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/")
            return new Response(importHtml, {
              headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
            });
          if (request.method === "GET" && url.pathname === "/import.js")
            return new Response(importJs, {
              headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
            });
          if (request.method === "GET" && url.pathname === "/import.css")
            return new Response(importCss, {
              headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
            });
          if (request.method === "GET" && url.pathname === "/api/session") return json({ token });
          if (request.headers.get("x-detroit-token") !== token)
            return json({ error: "invalid session token" }, 403);
          if (request.method !== "GET" && requestOrigin !== origin)
            return json({ error: "mutation requires same-origin Origin" }, 403);
          if (request.method === "GET" && url.pathname === "/api/state")
            return json({
              cases: imports.list(),
              collections: imports.collections(),
              sources: imports.sourceGroups(),
            });
          const caseMatch = /^\/api\/cases\/([^/]+)(?:\/materials\/([^/]+))?$/.exec(url.pathname);
          if (request.method === "GET" && caseMatch) {
            const caseId = decodeURIComponent(caseMatch[1]!);
            const revisionText = url.searchParams.get("revision");
            const revision = revisionText === null ? undefined : Number(revisionText);
            if (revision !== undefined && (!Number.isInteger(revision) || revision < 1))
              throw new Error("invalid revision");
            if (!caseMatch[2]) return json(imports.get(caseId, revision));
            const material = imports.material(caseId, decodeURIComponent(caseMatch[2]), revision);
            return new Response(material.bytes, {
              headers: {
                ...headers,
                "Content-Type": "application/octet-stream",
                "Content-Disposition": "attachment; filename=material.bin",
              },
            });
          }
          if (request.method !== "POST") return json({ error: "not found" }, 404);
          if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
            throw new Error("JSON body required");
          const declaredLength = Number(request.headers.get("content-length") ?? 0);
          if (declaredLength > requestLimit) return json({ error: "request too large" }, 413);
          const reader = request.body?.getReader();
          if (!reader) throw new Error("JSON body required");
          let size = 0;
          let body = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > requestLimit) {
              await reader.cancel();
              return json({ error: "request too large" }, 413);
            }
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
          const parsed: unknown = JSON.parse(body);
          if (url.pathname === "/api/preview" || url.pathname === "/api/import") {
            const importRequest =
              url.pathname === "/api/import" ? importRequestSchema.parse(parsed) : undefined;
            const payload = importRequest
              ? importRequest.payload
              : importPayloadSchema.parse(parsed);
            if (
              payload.manifest.workspaces.some((workspace) => workspace.path !== undefined) ||
              payload.manifest.materials.some((material) => material.sourcePath !== undefined)
            )
              throw new Error(
                "Web import accepts uploaded bytes only; remove local path/sourcePath and select files in the browser",
              );
            if (url.pathname === "/api/preview") return json(imports.preview(payload));
            if (!importRequest) throw new Error("import confirmation required");
            return json(imports.confirm(payload, importRequest.confirmation), 201);
          }
          if (url.pathname === "/api/collections")
            return json(imports.createCollection(collectionInputSchema.parse(parsed)), 201);
          const collectionMatch = /^\/api\/collections\/([^/]+)\/cases$/.exec(url.pathname);
          if (collectionMatch) {
            const input = collectionMemberSchema.parse(parsed);
            return json(
              imports.addToCollection(input.caseId, decodeURIComponent(collectionMatch[1]!), input),
            );
          }
          return json({ error: "not found" }, 404);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    host = `127.0.0.1:${server.port}`;
    console.log(
      `Detroit case importer: ${origin}\nData: ${root}\nImport only; no model calls or project commands. Ctrl+C to stop.`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await server?.stop(true);
    store?.close();
    release();
  }
}
