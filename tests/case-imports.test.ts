import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseImports } from "../src/case-imports";
import { digest } from "../src/evidence";
import { type ImportPayload, importPayloadSchema } from "../src/import-contract";
import { Store } from "../src/store";

const fixtures: { root: string; store: Store }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "detroit-import-"));
  const store = new Store(join(root, "data"));
  fixtures.push({ root, store });
  return { root, store, imports: new CaseImports(store) };
}

// Every consumer example uses the public schema's actual defaults.
function payload(): ImportPayload {
  return importPayloadSchema.parse({
    manifest: {
      kind: "detroit.case",
      schemaVersion: 1,
      title: "真实输入归档",
      instruction: "Compare the supplied event with the documented expected result.",
      source: { kind: "oncall", reference: "incident-42", description: "用户批准的故障材料" },
      start: { kind: "current" },
      acceptance: { kind: "manual", description: "Review the private acceptance evidence." },
    },
    files: [{ path: "event.json", encoding: "utf8", data: '{"event":"login"}' }],
  });
}

test("uploads preserve PC/APP snapshots, binary bytes, explicit private roles, and inert commands", async () => {
  const { root, store, imports } = await fixture();
  const input = payload();
  input.manifest.workspaces = [
    { id: "pc", name: "PC", revision: "user-declared-sha", snapshot: "current", required: true },
    { id: "app", name: "APP", revision: null, snapshot: "current", required: true },
  ];
  input.manifest.environment = {
    requirements: ["node"],
    preparation: [`touch ${join(root, "should-not-exist")}`],
    network: "host",
    credentials: ["user-approved later"],
  };
  input.files.push(
    {
      workspaceId: "pc",
      path: "src/login.ts",
      data: "export const pc = 1;",
      encoding: "utf8",
      role: "input",
      required: true,
      mode: 0o755,
    },
    {
      workspaceId: "app",
      path: "src/login.ts",
      data: "export const app = 1;",
      encoding: "utf8",
      role: "input",
      required: true,
      mode: 0o644,
    },
    {
      workspaceId: "pc",
      path: "private/diagnosis.bin",
      data: Buffer.from([0, 255, 128, 65]).toString("base64"),
      encoding: "base64",
      role: "diagnostic",
      required: false,
      mode: 0o600,
    },
    {
      workspaceId: null,
      path: "acceptance.txt",
      data: "private expected outcome",
      encoding: "utf8",
      role: "scoring",
      required: true,
      mode: 0o600,
    },
  );
  const preview = imports.preview(input);
  expect(preview.fileCount).toBe(5);
  expect(preview.readiness.materialsComplete).toBe(true);
  expect(preview.readiness.baselineDeclared).toBe(true);
  expect(preview.readiness.executionSupported).toBe(false);
  expect(preview.readiness.blockers).toEqual(["executor_not_connected"]);
  expect(preview.warnings).toContain("snapshot_revision_unverified:pc");
  expect(store.db.query("SELECT COUNT(*) AS count FROM import_blobs").get()).toEqual({ count: 0 });
  const saved = imports.confirm(input, { approved: true, approvalDigest: preview.approvalDigest });
  const diagnostic = saved.materials.find((material) => material.role === "diagnostic")!;
  expect(imports.material(saved.id, diagnostic.id).bytes).toEqual(Buffer.from([0, 255, 128, 65]));
  expect(diagnostic.workspaceId).toBe("pc");
  expect(saved.materials.filter((material) => material.role === "input")).toHaveLength(3);
  expect(saved.manifest.environment.preparation).toEqual(input.manifest.environment.preparation);
  await expect(readFile(join(root, "should-not-exist"))).rejects.toThrow();
  expect(imports.get(saved.id)).toEqual(saved);
});

test("empty and incomplete materials save blocked drafts without inventing an original baseline", async () => {
  const { imports } = await fixture();
  const input = payload();
  input.files = [];
  input.manifest.start.kind = "original";
  input.manifest.workspaces = [
    {
      id: "pc",
      name: "PC",
      revision: "declared-not-observed",
      snapshot: "current",
      required: true,
    },
  ];
  input.manifest.materials = [
    {
      workspaceId: "pc",
      path: "src/missing.ts",
      role: "input",
      required: true,
      state: "present",
      mode: 0o644,
    },
    {
      workspaceId: null,
      path: "old.log",
      role: "diagnostic",
      required: false,
      state: "missing",
      mode: 0o644,
    },
    {
      workspaceId: "pc",
      path: "removed.ts",
      role: "input",
      required: true,
      state: "deleted",
      mode: 0o644,
    },
  ];
  input.manifest.acceptance = { kind: "unspecified", description: "" };
  const preview = imports.preview(input);
  expect(preview.materials.map((material) => material.state)).toContain("missing");
  expect(preview.readiness.materialsComplete).toBe(false);
  expect(preview.readiness.baselineDeclared).toBe(false);
  expect(preview.readiness.blockers).toContain("missing_materials");
  expect(preview.readiness.blockers).toContain("missing_start_snapshot");
  expect(preview.readiness.blockers).toContain("missing_start_snapshot:pc");
  expect(preview.readiness.blockers).toContain("missing_required_material:src/missing.ts");
  expect(preview.readiness.blockers).not.toContain("missing_required_material:removed.ts");
  expect(preview.readiness.warnings).toContain("optional_material_missing:old.log");
  const saved = imports.confirm(input, { approved: true, approvalDigest: preview.approvalDigest });
  expect(saved.manifest.start.kind).toBe("original");
  expect(saved.manifest.workspaces[0]!.snapshot).toBe("current");
  expect(saved.readiness.executionSupported).toBe(false);
  expect(() => imports.material(saved.id, saved.materials[0]!.id)).toThrow("no approved bytes");
});
test("an approved empty package marker is present baseline material, not a missing file", async () => {
  const { root, imports } = await fixture();
  await mkdir(join(root, "pc"));
  await writeFile(join(root, "pc/__init__.py"), "");
  const input = payload();
  input.manifest.workspaces = [
    { id: "pc", name: "PC", revision: null, snapshot: "current", required: true, path: "pc" },
  ];
  await writeFile(join(root, "manifest.json"), JSON.stringify(input.manifest));
  const prepared = await imports.prepareLocal(join(root, "manifest.json"));
  const preview = imports.preview(prepared);
  expect(preview.readiness.materialsComplete).toBe(true);
  expect(preview.readiness.baselineDeclared).toBe(true);
  const saved = imports.confirm(prepared, {
    approved: true,
    approvalDigest: preview.approvalDigest,
  });
  const marker = saved.materials.find((material) => material.path === "__init__.py")!;
  expect(marker.state).toBe("present");
  expect(marker.sha256).toBe(digest(Buffer.alloc(0)));
  expect(imports.material(saved.id, marker.id).bytes).toEqual(Buffer.alloc(0));
});

test("a self-contained text task needs no invented repository or input file", async () => {
  const { imports } = await fixture();
  const input = payload();
  input.files = [];
  input.manifest.instruction =
    "Explain the difference between enum conversion and numeric coercion.";
  const preview = imports.preview(input);
  expect(preview.readiness.materialsComplete).toBe(true);
  expect(preview.readiness.baselineDeclared).toBe(true);
  expect(preview.readiness.blockers).toEqual(["executor_not_connected"]);
  input.manifest.instruction = "";
  expect(imports.preview(input).readiness.blockers).toContain("missing_instruction");
});

test("diagnostic/scoring-only workspace cannot count as model-visible baseline input", async () => {
  const { imports } = await fixture();
  const input = payload();
  input.files[0]!.workspaceId = "pc";
  input.files[0]!.role = "diagnostic";
  input.manifest.workspaces = [
    { id: "pc", name: "PC", revision: null, snapshot: "original", required: true },
  ];
  input.manifest.start.kind = "original";
  const preview = imports.preview(input);
  expect(preview.readiness.blockers).toContain("missing_workspace_materials:pc");
  expect(preview.readiness.blockers).toContain("missing_input_materials");
  expect(preview.readiness.baselineDeclared).toBe(false);
});

test("approval binds bytes, manifest, metadata and warnings while equivalent encodings have the same digest", async () => {
  const { imports } = await fixture();
  const input = payload();
  const approved = imports.preview(input).approvalDigest;
  const base64 = structuredClone(input);
  base64.files[0]!.encoding = "base64";
  base64.files[0]!.data = Buffer.from(input.files[0]!.data).toString("base64");
  expect(imports.preview(base64).approvalDigest).toBe(approved);
  const mutations = [
    (changed: ImportPayload) => {
      changed.files[0]!.data += "changed";
    },
    (changed: ImportPayload) => {
      changed.files[0]!.role = "scoring";
    },
    (changed: ImportPayload) => {
      changed.files[0]!.required = false;
    },
    (changed: ImportPayload) => {
      changed.files[0]!.mode = 0o755;
    },
    (changed: ImportPayload) => {
      changed.manifest.instruction += "changed";
    },
    (changed: ImportPayload) => {
      changed.warnings.push("new import disclosure");
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(input);
    mutate(changed);
    expect(() => imports.confirm(changed, { approved: true, approvalDigest: approved })).toThrow(
      "Approval digest mismatch",
    );
  }
  expect(() => imports.confirm(input, { approved: false, approvalDigest: approved })).toThrow();
  expect(imports.list()).toEqual([]);
});

test("unsafe logical paths, duplicate material names, mismatched roles and malformed encodings are rejected", async () => {
  const { imports } = await fixture();
  for (const path of [
    "../outside",
    "/absolute",
    "a/../b",
    "a//b",
    "a\\b",
    "C:/file",
    "a\u0000b",
    ".git/config",
    "node_modules/a",
    ".detroit/index.sqlite",
  ]) {
    const input = payload();
    input.files[0]!.path = path;
    expect(() => imports.preview(input)).toThrow();
  }
  const duplicate = payload();
  duplicate.files.push({ ...duplicate.files[0]! });
  expect(() => imports.preview(duplicate)).toThrow("Duplicate uploaded file");
  const collision = payload();
  collision.files.push({ ...collision.files[0]!, path: "event.json/nested" });
  expect(() => imports.preview(collision)).toThrow("File/directory");
  const roles = payload();
  roles.manifest.materials = [
    {
      workspaceId: null,
      path: "event.json",
      role: "scoring",
      required: true,
      mode: 0o644,
      state: "present",
    },
  ];
  expect(() => imports.preview(roles)).toThrow("metadata conflicts");
  roles.files[0]!.role = "scoring";
  roles.manifest.materials[0]!.sha256 = "0".repeat(64);
  expect(() => imports.preview(roles)).toThrow("hash mismatch");
  for (const data of ["%%%", "Zg", "Zh==", "Zg==\n"]) {
    const input = payload();
    input.files[0]!.encoding = "base64";
    input.files[0]!.data = data;
    expect(() => imports.preview(input)).toThrow("base64");
  }
  const foreignWorkspace = payload();
  foreignWorkspace.files[0]!.workspaceId = "undeclared";
  expect(() => imports.preview(foreignWorkspace)).toThrow("Unknown workspace");
  const unsafeMode = payload();
  unsafeMode.files[0]!.mode = 0o4755;
  expect(() => imports.preview(unsafeMode)).toThrow();
});

test("local preparation imports two actual directories and attachments, filters secrets and preserves executable bits", async () => {
  const { root, imports } = await fixture();
  await mkdir(join(root, "pc/src"), { recursive: true });
  await mkdir(join(root, "app/src"), { recursive: true });
  await mkdir(join(root, "pc/.git"));
  await mkdir(join(root, "pc/node_modules"));
  await mkdir(join(root, "pc/.detroit"));
  await writeFile(join(root, "pc/src/main.sh"), "#!/bin/sh\necho must-not-run\n");
  await chmod(join(root, "pc/src/main.sh"), 0o4755);
  await writeFile(join(root, "app/src/main.ts"), "export const app = true;");
  await writeFile(join(root, "pc/.env"), "PRIVATE_SECRET=do-not-copy");
  await writeFile(join(root, "pc/.git/config"), "private repo credentials");
  await writeFile(join(root, "pc/node_modules/private.js"), "not requested");
  await writeFile(join(root, "diagnosis.bin"), Buffer.from([0, 255, 8]));
  const input = payload();
  input.files = [];
  input.manifest.workspaces = [
    { id: "pc", name: "PC", revision: "declared", snapshot: "current", required: true, path: "pc" },
    { id: "app", name: "APP", revision: null, snapshot: "current", required: true, path: "app" },
  ];
  input.manifest.materials = [
    {
      workspaceId: null,
      path: "private/rootcause.bin",
      sourcePath: "diagnosis.bin",
      role: "diagnostic",
      required: false,
      mode: 0o644,
      state: "present",
    },
  ];
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(input.manifest));
  const prepared = await imports.prepareLocal(manifestPath);
  const preview = imports.preview(prepared);
  expect(preview.fileCount).toBe(3);
  expect(preview.materials.find((material) => material.path === "src/main.sh")!.mode).toBe(0o755);
  expect(
    preview.materials.find((material) => material.path === "private/rootcause.bin")!.role,
  ).toBe("diagnostic");
  expect(preview.warnings).toContain("local_path_ignored:pc/.env");
  expect(preview.warnings).toContain("local_path_ignored:pc/.git");
  expect(preview.warnings).toContain("local_snapshot_non_atomic:pc");
  expect(prepared.manifest.workspaces[0]!.path).toBeUndefined();
  expect(prepared.manifest.materials[0]!.sourcePath).toBeUndefined();
  expect(JSON.stringify(prepared)).not.toContain("do-not-copy");
  const saved = imports.confirm(prepared, {
    approved: true,
    approvalDigest: preview.approvalDigest,
  });
  const material = saved.materials.find((item) => item.path === "private/rootcause.bin")!;
  expect(imports.material(saved.id, material.id).bytes).toEqual(Buffer.from([0, 255, 8]));
});

test("changed local bytes require a new approval and preview never follows host path declarations", async () => {
  const { root, imports } = await fixture();
  const input = payload();
  input.files = [];
  input.manifest.materials = [
    {
      workspaceId: null,
      path: "event.json",
      sourcePath: "event.json",
      role: "input",
      required: true,
      mode: 0o644,
      state: "present",
    },
  ];
  await writeFile(join(root, "manifest.json"), JSON.stringify(input.manifest));
  await writeFile(join(root, "event.json"), "before");
  const first = await imports.prepareLocal(join(root, "manifest.json"));
  const approved = imports.preview(first).approvalDigest;
  await writeFile(join(root, "event.json"), "after!");
  const second = await imports.prepareLocal(join(root, "manifest.json"));
  expect(() => imports.confirm(second, { approved: true, approvalDigest: approved })).toThrow(
    "Approval digest mismatch",
  );
  const unresolved = imports.preview(input);
  expect(unresolved.fileCount).toBe(0);
  expect(unresolved.materials[0]!.state).toBe("missing");
  const saved = imports.confirm(input, {
    approved: true,
    approvalDigest: unresolved.approvalDigest,
  });
  expect(saved.readiness.materialsComplete).toBe(false);
  expect(saved.materials[0]!.sha256).toBeNull();
});

test("local scope refuses file/directory links, ancestor links and path escapes; missing sources remain drafts", async () => {
  const { root, imports } = await fixture();
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real/private.txt"), "not-followed");
  await symlink(join(root, "real"), join(root, "linked"));
  await symlink(join(root, "real/private.txt"), join(root, "file-link"));
  const manifestPath = join(root, "manifest.json");
  for (const sourcePath of [
    "../outside",
    "linked/private.txt",
    "file-link",
    join(root, "real/private.txt"),
  ]) {
    const input = payload();
    input.files = [];
    input.manifest.materials = [
      {
        workspaceId: null,
        path: "input.txt",
        sourcePath,
        role: "input",
        required: true,
        mode: 0o644,
        state: "present",
      },
    ];
    await writeFile(manifestPath, JSON.stringify(input.manifest));
    await expect(imports.prepareLocal(manifestPath)).rejects.toThrow();
  }
  const workspaceInput = payload();
  workspaceInput.files = [];
  workspaceInput.manifest.workspaces = [
    { id: "pc", name: "PC", snapshot: "current", revision: null, required: true, path: "linked" },
  ];
  await writeFile(manifestPath, JSON.stringify(workspaceInput.manifest));
  await expect(imports.prepareLocal(manifestPath)).rejects.toThrow();
  await symlink(join(root, "real/private.txt"), join(root, "real/nested-link"));
  workspaceInput.manifest.workspaces[0]!.path = "real";
  await writeFile(manifestPath, JSON.stringify(workspaceInput.manifest));
  await expect(imports.prepareLocal(manifestPath)).rejects.toThrow("Symlinks");
  workspaceInput.manifest.workspaces[0]!.path = "missing-directory";
  workspaceInput.manifest.materials = [
    {
      workspaceId: null,
      path: "missing.txt",
      sourcePath: "not-present",
      role: "input",
      required: true,
      mode: 0o644,
      state: "present",
    },
  ];
  await writeFile(manifestPath, JSON.stringify(workspaceInput.manifest));
  const prepared = await imports.prepareLocal(manifestPath);
  expect(prepared.manifest.workspaces[0]!.snapshot).toBe("missing");
  expect(prepared.manifest.materials[0]!.state).toBe("missing");
  const preview = imports.preview(prepared);
  const saved = imports.confirm(prepared, {
    approved: true,
    approvalDigest: preview.approvalDigest,
  });
  expect(saved.readiness.blockers).toContain("missing_start_snapshot");
});

test("local preparation refuses special files before opening them, including a FIFO that would otherwise block", async () => {
  const { root, imports } = await fixture();
  const fifo = join(root, "pipe");
  const created = Bun.spawnSync(["mkfifo", fifo]);
  expect(created.exitCode).toBe(0);
  const input = payload();
  input.files = [];
  input.manifest.materials = [
    {
      workspaceId: null,
      path: "input.txt",
      sourcePath: "pipe",
      role: "input",
      required: true,
      mode: 0o644,
      state: "present",
    },
  ];
  await writeFile(join(root, "manifest.json"), JSON.stringify(input.manifest));
  await expect(imports.prepareLocal(join(root, "manifest.json"))).rejects.toThrow("special files");
});

test("material and manifest size limits reject oversized content before storing any bytes", async () => {
  const { store, imports } = await fixture();
  const oversized = payload();
  oversized.files[0]!.data = "x".repeat(16 * 1024 * 1024 + 1);
  expect(() => imports.preview(oversized)).toThrow("Material byte limit exceeded");
  const manifest = payload();
  manifest.manifest.environment.requirements = ["x".repeat(1024 * 1024)];
  expect(() => imports.preview(manifest)).toThrow("Manifest byte limit exceeded");
  expect(store.db.query("SELECT COUNT(*) AS count FROM import_blobs").get()).toEqual({ count: 0 });
});

test("revisions are immutable, stale edits fail and collection references stay pinned until explicit replacement", async () => {
  const { store, imports } = await fixture();
  const input = payload();
  const first = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  const collection = imports.createCollection({
    name: "Validation regression",
    purpose: "validation",
    regression: true,
  });
  imports.addToCollection(first.id, collection.id, { weight: 2.5 });
  input.manifest.source.groupId = first.sourceGroupId;
  input.manifest.title = "修订后的任务";
  input.files[0]!.data = "revision two bytes";
  const approvalDigest = imports.preview(input).approvalDigest;
  expect(() =>
    imports.confirm(input, { approved: true, approvalDigest, caseId: first.id }),
  ).toThrow("Stale case revision");
  const second = imports.confirm(input, {
    approved: true,
    approvalDigest,
    caseId: first.id,
    expectedRevision: 1,
  });
  expect(second.revision).toBe(2);
  expect(second.draftId).not.toBe(first.draftId);
  expect(imports.get(first.id, 1).manifest.title).toBe(first.manifest.title);
  expect(imports.material(first.id, first.materials[0]!.id, 1).bytes.toString()).toBe(
    payload().files[0]!.data,
  );
  expect(imports.material(first.id, second.materials[0]!.id, 2).bytes.toString()).toBe(
    "revision two bytes",
  );
  expect(imports.collections()[0]!.entries[0]!.revision).toBe(1);
  expect(() =>
    imports.confirm(input, {
      approved: true,
      approvalDigest,
      caseId: first.id,
      expectedRevision: 1,
    }),
  ).toThrow("Stale case revision");
  imports.addToCollection(first.id, collection.id, { revision: 2, weight: 4 });
  expect(imports.collections()[0]!.entries).toEqual([
    { caseId: first.id, draftId: second.draftId, revision: 2, weight: 4 },
  ]);
  expect(() =>
    store.db.query("UPDATE import_drafts SET manifest_json='{}' WHERE id=?").run(first.draftId),
  ).toThrow("Immutable");
  expect(() =>
    store.db.query("DELETE FROM import_materials WHERE draft_id=?").run(first.draftId),
  ).toThrow("Immutable");
});

test("switching original/current start creates a linked independent case instead of overwriting case identity", async () => {
  const { imports } = await fixture();
  const input = payload();
  const current = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  input.manifest.source.groupId = current.sourceGroupId;
  input.manifest.start.kind = "original";
  input.manifest.start.description =
    "User-supplied original input, distinct from the current task.";
  const approvalDigest = imports.preview(input).approvalDigest;
  expect(() =>
    imports.confirm(input, {
      approved: true,
      approvalDigest,
      caseId: current.id,
      expectedRevision: 1,
    }),
  ).toThrow("new linked case");
  expect(imports.get(current.id).revision).toBe(1);
  expect(imports.get(current.id).manifest.start.kind).toBe("current");
  const original = imports.confirm(input, { approved: true, approvalDigest });
  expect(original.id).not.toBe(current.id);
  expect(original.sourceGroupId).toBe(current.sourceGroupId);
  expect(original.revision).toBe(1);
  expect(original.manifest.start.kind).toBe("original");
  input.manifest.start.description = "Additional approved original-start explanation.";
  const revised = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
    caseId: original.id,
    expectedRevision: 1,
  });
  expect(revised.id).toBe(original.id);
  expect(revised.revision).toBe(2);
  expect(revised.manifest.start.kind).toBe("original");
});

test("source exposure requires explicit confirmation/reason, propagates across linked cases and invalidates approvals", async () => {
  const { store, imports } = await fixture();
  const input = payload();
  const first = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  input.manifest.source.groupId = first.sourceGroupId;
  input.manifest.title = "Same incident, independent task";
  const second = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  const improvement = imports.createCollection({
    name: "Improvement",
    purpose: "improvement",
    regression: true,
  });
  const validation = imports.createCollection({
    name: "Independent validation",
    purpose: "validation",
  });
  imports.addToCollection(second.id, validation.id);
  const oldApproval = imports.preview(input).approvalDigest;
  expect(() => imports.addToCollection(first.id, improvement.id)).toThrow("confirmExposure=true");
  expect(() =>
    imports.addToCollection(first.id, improvement.id, {
      confirmExposure: true,
      exposureReason: " ",
    }),
  ).toThrow("exposureReason");
  expect(imports.sourceGroups()[0]!.purpose).toBe("validation");
  imports.addToCollection(first.id, improvement.id, {
    confirmExposure: true,
    exposureReason: "Optimize using this incident; expose all linked tasks.",
  });
  expect(imports.sourceGroups()[0]!.purpose).toBe("improvement");
  expect(imports.sourceGroups()[0]!.exposedAt).not.toBeNull();
  expect(imports.get(second.id).readiness.warnings).toContain(
    "source_group_exposed_for_improvement",
  );
  expect(imports.collections().find((item) => item.id === validation.id)!.entries[0]!.caseId).toBe(
    second.id,
  );
  expect(() => imports.confirm(input, { approved: true, approvalDigest: oldApproval })).toThrow(
    "Approval digest mismatch",
  );
  const preview = imports.preview(input);
  expect(preview.warnings).toContain("source_validation_conflict_requires_confirmation_and_reason");
  expect(() =>
    imports.confirm(input, { approved: true, approvalDigest: preview.approvalDigest }),
  ).toThrow("Source validation conflict");
  const third = imports.confirm(input, {
    approved: true,
    approvalDigest: preview.approvalDigest,
    confirmExposure: true,
    exposureReason: "I acknowledge this source is exposed, not independent validation.",
  });
  expect(third.manifest.source.usedForImprovement).toBe(false);
  expect(imports.sourceGroups()[0]!.purpose).toBe("improvement");
  expect(() =>
    imports.addToCollection(third.id, validation.id, {
      confirmExposure: true,
      exposureReason: "cannot undo exposure",
    }),
  ).toThrow("Validation collection");
  expect(store.db.query("SELECT COUNT(*) AS count FROM import_exposures").get()).toEqual({
    count: 2,
  });
  input.manifest.source.usedForImprovement = true;
  expect(() =>
    imports.confirm(input, {
      approved: true,
      approvalDigest: imports.preview(input).approvalDigest,
    }),
  ).not.toThrow();
});

test("source identity is explicit, never inferred from equal content; incorrect group use and missing references fail atomically", async () => {
  const { store, imports } = await fixture();
  const input = payload();
  const first = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  expect(() => imports.preview(input)).toThrow();
  input.manifest.source.reference = "incident-43";
  const independent = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  expect(independent.sourceGroupId).not.toBe(first.sourceGroupId);
  input.manifest.source.reference = "incident-42";
  input.manifest.source.groupId = first.sourceGroupId;
  input.manifest.source.reference = "different-incident";
  expect(() => imports.preview(input)).toThrow("identity conflicts");
  input.manifest.source.reference = "incident-42";
  input.manifest.source.groupId = "unknown";
  expect(() => imports.preview(input)).toThrow("Unknown source group");
  input.manifest.source.groupId = first.sourceGroupId;
  const approved = imports.preview(input).approvalDigest;
  expect(() =>
    imports.confirm(input, { approved: true, approvalDigest: approved, collectionId: "unknown" }),
  ).toThrow("Unknown collection");
  expect(imports.list()).toHaveLength(2);
  expect(imports.sourceGroups()).toHaveLength(2);
  expect(() =>
    store.db.query("INSERT INTO import_cases VALUES ('foreign-case','unknown-source','now')").run(),
  ).toThrow();
  const collection = imports.createCollection({ name: "References", purpose: "validation" });
  expect(() =>
    store.db
      .query("INSERT INTO import_members VALUES (?,?,?,?,?)")
      .run(collection.id, first.id, independent.draftId, independent.revision, 1),
  ).toThrow();
  expect(() => imports.addToCollection("unknown-case", collection.id)).toThrow("Unknown case");
  expect(() => imports.addToCollection(first.id, collection.id, { revision: 99 })).toThrow(
    "Unknown case/revision",
  );
  const thirdInput = payload();
  thirdInput.manifest.source.reference = "incident-44";
  thirdInput.files[0]!.path = "other.txt";
  const third = imports.confirm(thirdInput, {
    approved: true,
    approvalDigest: imports.preview(thirdInput).approvalDigest,
  });
  expect(() => imports.material(first.id, third.materials[0]!.id)).toThrow("does not belong");
  expect(imports.collections()[0]!.entries).toEqual([]);
});

test("migration preserves v1 experiment/trial/attempt/evaluation rows and reopening cannot downgrade schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-import-legacy-"));
  const store = new Store(join(root, "data"));
  fixtures.push({ root, store });
  const json = '{"legacy":"original fixture experiment"}';
  store.db
    .query("INSERT INTO experiments VALUES (?,?,?,?,?)")
    .run("legacy-exp", "Old experiment", json, digest(json), "before-import");
  store.db
    .query("INSERT INTO trials VALUES (?,?,?,?,?,?)")
    .run("legacy-trial", "legacy-exp", "clamp", "noop", 0, 0);
  store.db
    .query("INSERT INTO attempts VALUES (?,?,?,?,?,?,?)")
    .run("legacy-attempt", "legacy-trial", "finished", "legacy-dir", '{"old":true}', null, "done");
  store.db
    .query("INSERT INTO evaluations VALUES (?,?,?,?,?,?)")
    .run(1, "legacy-attempt", "old-evidence", "old-scoring", '{"status":"pass"}', "before-import");
  const before = ["experiments", "trials", "attempts", "evaluations"].map((table) =>
    store.db.query(`SELECT * FROM ${table}`).all(),
  );
  const imports = new CaseImports(store);
  imports.createCollection({ name: "New collection", purpose: "validation" });
  const input = payload();
  imports.confirm(input, { approved: true, approvalDigest: imports.preview(input).approvalDigest });
  const after = ["experiments", "trials", "attempts", "evaluations"].map((table) =>
    store.db.query(`SELECT * FROM ${table}`).all(),
  );
  expect(after).toEqual(before);
  expect(store.experiment("legacy-exp").spec_json).toBe(json);
  expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  const reopened = new Store(join(root, "data"));
  try {
    expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(new CaseImports(reopened).list()).toHaveLength(1);
    expect(reopened.evaluations("legacy-attempt")[0]!.result_json).toBe('{"status":"pass"}');
  } finally {
    reopened.close();
  }
});

test("failed schema migration rolls back entirely and an unsupported schema is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "detroit-import-migration-"));
  const store = new Store(join(root, "data"));
  fixtures.push({ root, store });
  store.db.exec("CREATE TABLE import_materials (existing TEXT)");
  expect(() => new CaseImports(store)).toThrow();
  expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(
    store.db.query("SELECT name FROM sqlite_master WHERE name='import_sources'").get(),
  ).toBeNull();
  store.db.exec("PRAGMA user_version=3");
  expect(() => new CaseImports(store)).toThrow("Unsupported data schema version");
  const direct = new Database(join(root, "data/index.sqlite"));
  try {
    expect(direct.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  } finally {
    direct.close();
  }
});

test("a versioned payload can carry material bytes beyond the metadata-only manifest limit", async () => {
  const { root, imports } = await fixture();
  const input = payload();
  input.files[0]!.path = "large-diagnostic.log";
  input.files[0]!.role = "diagnostic";
  input.files[0]!.required = false;
  input.files[0]!.data = "trace-line\n".repeat(110000);
  const manifestPath = join(root, "payload.json");
  await writeFile(manifestPath, JSON.stringify(input));
  const prepared = await imports.prepareLocal(manifestPath);
  const preview = imports.preview(prepared);
  const saved = imports.confirm(prepared, {
    approved: true,
    approvalDigest: preview.approvalDigest,
  });
  const material = saved.materials[0]!;
  expect(material.role).toBe("diagnostic");
  expect(material.sha256).toBe(digest(Buffer.from(input.files[0]!.data)));
  expect(
    imports.material(saved.id, material.id).bytes.equals(Buffer.from(input.files[0]!.data)),
  ).toBe(true);
});

test("malformed persisted drafts cannot advertise execution or return unchecked task descriptions", async () => {
  const { store, imports } = await fixture();
  const input = payload();
  const saved = imports.confirm(input, {
    approved: true,
    approvalDigest: imports.preview(input).approvalDigest,
  });
  // Simulate an incompatible/corrupted persisted blob, not a supported editing path.
  store.db.exec("DROP TRIGGER import_drafts_no_update");
  store.db
    .query("UPDATE import_drafts SET readiness_json=? WHERE id=?")
    .run(JSON.stringify({ ...saved.readiness, executionSupported: true }), saved.draftId);
  expect(() => imports.get(saved.id)).toThrow();
  store.db
    .query("UPDATE import_drafts SET readiness_json=?,manifest_json=? WHERE id=?")
    .run(
      JSON.stringify(saved.readiness),
      JSON.stringify({ ...saved.manifest, instruction: 42 }),
      saved.draftId,
    );
  expect(() => imports.list()).toThrow();
});
