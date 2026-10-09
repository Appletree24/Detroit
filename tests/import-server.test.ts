import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ImportedCase, ImportPreview } from "../src/import-contract";

const project = resolve(import.meta.dir, "..");

test("local import API requires same-origin approval, scopes materials, and never executes preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-import-api-"));
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "serve", "--port", "0", "--data", root],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let origin: string | undefined;
    while (!origin) {
      const next = await reader.read();
      if (next.done)
        throw new Error(`server exited before ready: ${await new Response(child.stderr).text()}`);
      output += decoder.decode(next.value, { stream: true });
      origin = /Detroit case importer: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    }
    reader.releaseLock();
    expect(
      (await fetch(`${origin}/api/session`, { headers: { Origin: "http://attacker.invalid" } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(`${origin}/api/session`, { headers: { Host: "attacker.invalid" } })).status,
    ).toBe(403);
    expect((await fetch(`${origin}/api/state`)).status).toBe(403);
    const session: { token: string } = await (await fetch(`${origin}/api/session`)).json();
    const headers = {
      "Content-Type": "application/json",
      "X-Detroit-Token": session.token,
      Origin: origin,
    };
    const collectionResponse = await fetch(`${origin}/api/collections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "oncall regression", purpose: "improvement", regression: true }),
    });
    expect(collectionResponse.status).toBe(201);
    const collection: { id: string } = await collectionResponse.json();
    const payload = {
      manifest: {
        kind: "detroit.case",
        schemaVersion: 1,
        title: "PC/App enum conversion discrepancy",
        instruction: "Compare both implementations for the same response.",
        source: { kind: "oncall", reference: "test-oncall", usedForImprovement: true },
        start: { kind: "original" },
        workspaces: [
          { id: "pc", name: "PC", revision: "declared-pc", snapshot: "original" },
          { id: "app", name: "App", revision: "declared-app", snapshot: "original" },
        ],
        environment: {
          preparation: [`touch ${join(root, "must-not-execute")}`],
          network: "host",
          credentials: ["DO_NOT_READ"],
        },
        acceptance: {
          kind: "manual",
          description: "Correctly identify differing enum conversions.",
        },
      },
      files: [
        {
          workspaceId: "pc",
          path: "src/convert.ts",
          encoding: "utf8",
          data: "export const i32 = (value) => enumLib(value);",
          role: "input",
        },
        {
          workspaceId: "app",
          path: "src/convert.ts",
          encoding: "utf8",
          data: "export const i32 = (value) => Number(value) | 0;",
          role: "input",
        },
        {
          path: "root-cause.txt",
          encoding: "utf8",
          data: "Private diagnosis: PC's enum library returns zero.",
          role: "scoring",
        },
      ],
    };
    const body = JSON.stringify(payload);
    expect(
      (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Detroit-Token": session.token },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers: { ...headers, Origin: "http://attacker.invalid" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/jsonp" },
          body,
        })
      ).status,
    ).toBe(400);
    const unsafe = structuredClone(payload);
    Object.assign(unsafe.manifest.workspaces[0]!, { path: "/etc" });
    expect(
      (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers,
          body: JSON.stringify(unsafe),
        })
      ).status,
    ).toBe(400);
    const previewResponse = await fetch(`${origin}/api/preview`, { method: "POST", headers, body });
    expect(previewResponse.status).toBe(200);
    const preview: ImportPreview = await previewResponse.json();
    expect(preview.readiness.executionSupported).toBe(false);
    expect(preview.materials.find((material) => material.path === "root-cause.txt")?.role).toBe(
      "scoring",
    );
    const changed = structuredClone(payload);
    changed.files[0]!.data = "different snapshot";
    const confirmation = {
      approved: true,
      approvalDigest: preview.approvalDigest,
      collectionId: collection.id,
    };
    expect(
      (
        await fetch(`${origin}/api/import`, {
          method: "POST",
          headers,
          body: JSON.stringify({ payload: changed, confirmation }),
        })
      ).status,
    ).toBe(400);
    const emptyState: { cases: unknown[] } = await (
      await fetch(`${origin}/api/state`, { headers })
    ).json();
    expect(emptyState.cases).toEqual([]);
    const savedResponse = await fetch(`${origin}/api/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload, confirmation }),
    });
    expect(savedResponse.status).toBe(201);
    const saved: ImportedCase = await savedResponse.json();
    expect(saved.revision).toBe(1);
    expect(saved.manifest.workspaces.map((workspace) => workspace.id)).toEqual(["pc", "app"]);
    const privateMaterial = saved.materials.find((material) => material.path === "root-cause.txt")!;
    const download = await fetch(
      `${origin}/api/cases/${saved.id}/materials/${privateMaterial.id}`,
      { headers },
    );
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(await download.text()).toBe(payload.files[2]!.data);
    expect(
      (await fetch(`${origin}/api/cases/${saved.id}/materials/not-this-case`, { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(`${origin}/api/cases/${saved.id}/materials/${privateMaterial.id}`)).status,
    ).toBe(403);
    const state: { collections: { id: string; entries: { caseId: string; draftId: string }[] }[] } =
      await (await fetch(`${origin}/api/state`, { headers })).json();
    expect(state.collections.find((item) => item.id === collection.id)?.entries).toMatchObject([
      { caseId: saved.id, draftId: saved.draftId },
    ]);
    expect(existsSync(join(root, "must-not-execute"))).toBe(false);
  } finally {
    child.kill("SIGINT");
    await child.exited;
    expect(existsSync(join(root, "writer.lock"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("CLI binds explicit source groups before local validation and preserves linked case revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-import-cli-"));
  try {
    const manifestPath = join(root, "case.json");
    const manifest = {
      kind: "detroit.case",
      schemaVersion: 1,
      title: "Self-contained real task",
      instruction: "Explain enum conversion and numeric coercion.",
      source: { kind: "manual", reference: "cli-incident", usedForImprovement: true },
      start: { kind: "current" },
      acceptance: { kind: "manual", description: "Review conversion semantics." },
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const run = (args: string[]): unknown => {
      const child = Bun.spawnSync(
        [process.execPath, "src/cli.ts", ...args, "--data", join(root, "data")],
        { cwd: project },
      );
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      return JSON.parse(child.stdout.toString());
    };
    const previewSchema = z.object({ approvalDigest: z.string() });
    const savedSchema = z.object({
      id: z.string(),
      sourceGroupId: z.string(),
      revision: z.number().int(),
    });
    const preview = previewSchema.parse(run(["case", "preview", manifestPath]));
    const first = savedSchema.parse(
      run(["case", "import", manifestPath, "--approve", preview.approvalDigest]),
    );
    manifest.instruction += " Preserve uncertainty if the library behavior is not observed.";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const edit = previewSchema.parse(run(["case", "preview", manifestPath, "--case", first.id]));
    const updated = savedSchema.parse(
      run([
        "case",
        "import",
        manifestPath,
        "--case",
        first.id,
        "--expected-revision",
        "1",
        "--approve",
        edit.approvalDigest,
      ]),
    );
    expect(updated.id).toBe(first.id);
    expect(updated.revision).toBe(2);
    expect(updated.sourceGroupId).toBe(first.sourceGroupId);
    manifest.start.kind = "original";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const linkedPreview = previewSchema.parse(
      run(["case", "preview", manifestPath, "--source-group", first.sourceGroupId]),
    );
    const linked = savedSchema.parse(
      run([
        "case",
        "import",
        manifestPath,
        "--source-group",
        first.sourceGroupId,
        "--approve",
        linkedPreview.approvalDigest,
      ]),
    );
    expect(linked.id).not.toBe(first.id);
    expect(linked.sourceGroupId).toBe(first.sourceGroupId);
    const cases = z.array(savedSchema).parse(run(["case", "list"]));
    expect(cases.map((item) => item.id).sort()).toEqual([first.id, linked.id].sort());
    expect(cases.find((item) => item.id === first.id)?.revision).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
