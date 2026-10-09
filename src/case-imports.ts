import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { digest } from "./evidence";
import {
  type CaseCollection,
  collectionInputSchema,
  collectionMemberSchema,
  confirmationSchema,
  type ImportConfirmation,
  type ImportedCase,
  type ImportManifest,
  type ImportPayload,
  type ImportPreview,
  importLimits,
  importManifestSchema,
  importPayloadSchema,
  type PreviewMaterial,
  type Readiness,
  readinessSchema,
  type SourceGroup,
  type UploadedFile,
} from "./import-contract";
import type { Store } from "./store";

const reservedDirectories: Record<string, true> = {
  ".git": true,
  ".detroit": true,
  node_modules: true,
};
const secretNames: Record<string, true> = {
  ".env": true,
  ".npmrc": true,
  ".pypirc": true,
  "credentials.json": true,
  credentials: true,
  id_rsa: true,
  id_ed25519: true,
};

type SourceRow = {
  id: string;
  kind: SourceGroup["kind"];
  reference: string;
  description: string;
  purpose: SourceGroup["purpose"];
  exposed_at: string | null;
  created_at: string;
};
type DraftRow = {
  id: string;
  case_id: string;
  source_group_id: string;
  revision: number;
  manifest_json: string;
  readiness_json: string;
  approval_digest: string;
  created_at: string;
};
type MaterialRow = {
  id: string;
  workspace_id: string | null;
  path: string;
  role: PreviewMaterial["role"];
  required: number;
  mode: number;
  state: PreviewMaterial["state"];
  blob_sha256: string | null;
  byte_length: number;
};

// Logical material names are portable relative paths, never host paths.
function logicalPath(path: string): string {
  if (
    path.length > 4096 ||
    /[\\:]/.test(path) ||
    /\p{Cc}/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe material path: ${path}`);
  if (path.split("/").some((part) => Object.hasOwn(reservedDirectories, part)))
    throw new Error(`Reserved material path: ${path}`);
  return path;
}

function localPath(path: string): string[] {
  if (
    !path ||
    path.startsWith("/") ||
    /[\\:]/.test(path) ||
    /\p{Cc}/u.test(path) ||
    path.split("/").some((part) => !part || part === "..")
  )
    throw new Error(`Local path must stay within the manifest directory: ${path}`);
  return path.split("/").filter((part) => part !== ".");
}

function ignoredPath(path: string): boolean {
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return (
      Object.hasOwn(reservedDirectories, name) ||
      Object.hasOwn(secretNames, name) ||
      name.startsWith(".env.") ||
      /\.(pem|key|p12|pfx)$/.test(name)
    );
  });
}

// Every component is opened without following links; later reads use pinned fds.
async function openWithin(
  root: FileHandle,
  parts: string[],
  directory: boolean,
): Promise<FileHandle> {
  let parent = root;
  let owned = false;
  try {
    for (let index = 0; index < parts.length; index++) {
      const last = index === parts.length - 1;
      const path = `/proc/self/fd/${parent.fd}/${parts[index]}`;
      const initial = last && !directory ? await lstat(path) : null;
      if (initial && !initial.isFile())
        throw new Error(`Symlinks and special files cannot be imported: ${parts.join("/")}`);
      const handle = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (last && !directory ? 0 : constants.O_DIRECTORY),
      );
      if (initial) {
        try {
          const checked = await handle.stat();
          if (
            checked.dev !== initial.dev ||
            checked.ino !== initial.ino ||
            checked.mode !== initial.mode
          )
            throw new Error(`Source changed during import; retry preview: ${parts.join("/")}`);
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      if (owned) await parent.close();
      parent = handle;
      owned = true;
    }
    if (!owned)
      return await open(`/proc/self/fd/${root.fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY);
    return parent;
  } catch (error) {
    if (owned) await parent.close();
    throw error;
  }
}

async function readStable(handle: FileHandle, label: string, maximum: number): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error(`Only regular files can be imported: ${label}`);
  if (before.size > maximum) throw new Error(`File byte limit exceeded: ${label}`);
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  if (
    offset !== before.size ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.mode !== after.mode
  )
    throw new Error(`Source changed during import; retry preview: ${label}`);
  return bytes;
}

function metadata(row: MaterialRow): PreviewMaterial {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    role: row.role,
    required: Boolean(row.required),
    mode: row.mode,
    state: row.state,
    sha256: row.blob_sha256,
    bytes: row.byte_length,
  };
}

export class CaseImports {
  constructor(private readonly store: Store) {
    const version = store.schemaVersion;
    if (version === 2) return;
    if (version !== 1) throw new Error(`Unsupported data schema version: ${version}`);
    store.db
      .transaction(() => {
        store.db.exec(`
        CREATE TABLE import_sources (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('oncall','issue','session','manual')),
          reference TEXT NOT NULL, description TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK(purpose IN ('improvement','validation')),
          exposed_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE import_cases (
          id TEXT PRIMARY KEY, source_group_id TEXT NOT NULL REFERENCES import_sources(id), created_at TEXT NOT NULL
        );
        CREATE INDEX import_cases_source ON import_cases(source_group_id);
        CREATE TABLE import_drafts (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES import_cases(id), revision INTEGER NOT NULL CHECK(revision>0),
          manifest_json TEXT NOT NULL, readiness_json TEXT NOT NULL, approval_digest TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(case_id,revision), UNIQUE(case_id,id,revision)
        );
        CREATE TABLE import_workspaces (
          draft_id TEXT NOT NULL REFERENCES import_drafts(id), id TEXT NOT NULL, name TEXT NOT NULL, revision TEXT,
          snapshot TEXT NOT NULL CHECK(snapshot IN ('original','current','unknown','missing')),
          required INTEGER NOT NULL CHECK(required IN (0,1)), PRIMARY KEY(draft_id,id)
        );
        CREATE TABLE import_blobs (
          sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), bytes BLOB NOT NULL
        );
        CREATE TABLE import_materials (
          draft_id TEXT NOT NULL REFERENCES import_drafts(id), id TEXT NOT NULL, workspace_id TEXT,
          path TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('input','diagnostic','scoring')),
          required INTEGER NOT NULL CHECK(required IN (0,1)), mode INTEGER NOT NULL CHECK(mode BETWEEN 0 AND 511),
          state TEXT NOT NULL CHECK(state IN ('present','missing','deleted')),
          blob_sha256 TEXT REFERENCES import_blobs(sha256), byte_length INTEGER NOT NULL CHECK(byte_length>=0),
          CHECK((state='present' AND blob_sha256 IS NOT NULL) OR (state!='present' AND blob_sha256 IS NULL AND byte_length=0)),
          PRIMARY KEY(draft_id,id), FOREIGN KEY(draft_id,workspace_id) REFERENCES import_workspaces(draft_id,id)
        );
        CREATE UNIQUE INDEX import_material_paths ON import_materials(draft_id,COALESCE(workspace_id,''),path);
        CREATE INDEX import_material_blobs ON import_materials(blob_sha256);
        CREATE TABLE import_collections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('improvement','validation')),
          regression INTEGER NOT NULL CHECK(regression IN (0,1)), created_at TEXT NOT NULL
        );
        CREATE TABLE import_members (
          collection_id TEXT NOT NULL REFERENCES import_collections(id), case_id TEXT NOT NULL REFERENCES import_cases(id),
          draft_id TEXT NOT NULL, revision INTEGER NOT NULL, weight REAL NOT NULL CHECK(weight>=0),
          PRIMARY KEY(collection_id,case_id), FOREIGN KEY(case_id,draft_id,revision) REFERENCES import_drafts(case_id,id,revision)
        );
        CREATE INDEX import_members_draft ON import_members(draft_id);
        CREATE INDEX import_members_case ON import_members(case_id);
        CREATE TABLE import_exposures (
          id TEXT PRIMARY KEY, source_group_id TEXT NOT NULL REFERENCES import_sources(id),
          case_id TEXT REFERENCES import_cases(id), reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL
        );
        CREATE INDEX import_exposures_source ON import_exposures(source_group_id);
        CREATE TRIGGER import_drafts_no_update BEFORE UPDATE ON import_drafts BEGIN SELECT RAISE(ABORT,'Immutable import revision'); END;
        CREATE TRIGGER import_drafts_no_delete BEFORE DELETE ON import_drafts BEGIN SELECT RAISE(ABORT,'Immutable import revision'); END;
        CREATE TRIGGER import_workspaces_no_update BEFORE UPDATE ON import_workspaces BEGIN SELECT RAISE(ABORT,'Immutable import workspace'); END;
        CREATE TRIGGER import_workspaces_no_delete BEFORE DELETE ON import_workspaces BEGIN SELECT RAISE(ABORT,'Immutable import workspace'); END;
        CREATE TRIGGER import_materials_no_update BEFORE UPDATE ON import_materials BEGIN SELECT RAISE(ABORT,'Immutable import material'); END;
        CREATE TRIGGER import_materials_no_delete BEFORE DELETE ON import_materials BEGIN SELECT RAISE(ABORT,'Immutable import material'); END;
        CREATE TRIGGER import_blobs_no_update BEFORE UPDATE ON import_blobs BEGIN SELECT RAISE(ABORT,'Immutable import bytes'); END;
        CREATE TRIGGER import_blobs_no_delete BEFORE DELETE ON import_blobs BEGIN SELECT RAISE(ABORT,'Immutable import bytes'); END;
        PRAGMA user_version=2;
      `);
      })
      .immediate();
  }

  private source(id: string): SourceRow {
    const row = this.store.db
      .query("SELECT * FROM import_sources WHERE id=?")
      .get(id) as SourceRow | null;
    if (!row) throw new Error(`Unknown source group: ${id}`);
    return row;
  }

  private normalize(input: unknown): { preview: ImportPreview; bytes: Record<string, Buffer> } {
    const payload = importPayloadSchema.parse(input);
    const manifest = payload.manifest;
    if (Buffer.byteLength(JSON.stringify(manifest)) > importLimits.manifestBytes)
      throw new Error("Manifest byte limit exceeded");
    if (
      manifest.materials.length > importLimits.files ||
      manifest.workspaces.length > importLimits.files
    )
      throw new Error("Material/workspace count limit exceeded");
    if (manifest.source.groupId !== undefined && !manifest.source.groupId.trim())
      throw new Error("Source group ID must not be blank");
    const workspaces: Record<string, true> = Object.create(null);
    for (const workspace of manifest.workspaces) {
      if (workspaces[workspace.id]) throw new Error(`Duplicate workspace: ${workspace.id}`);
      workspaces[workspace.id] = true;
    }
    const declarations: Record<string, ImportManifest["materials"][number]> = Object.create(null);
    const keyFor = (workspaceId: string | null, path: string): string => {
      logicalPath(path);
      if (workspaceId !== null && !workspaces[workspaceId])
        throw new Error(`Unknown workspace: ${workspaceId}`);
      return JSON.stringify([workspaceId, path]);
    };
    for (const material of manifest.materials) {
      const key = keyFor(material.workspaceId, material.path);
      if (declarations[key]) throw new Error(`Duplicate material: ${material.path}`);
      declarations[key] = material;
    }
    const bytes: Record<string, Buffer> = Object.create(null);
    const hashes: Record<string, string> = Object.create(null);
    const uploaded: Record<string, true> = Object.create(null);
    let totalBytes = 0;
    for (const file of payload.files) {
      const key = keyFor(file.workspaceId, file.path);
      if (uploaded[key]) throw new Error(`Duplicate uploaded file: ${file.path}`);
      uploaded[key] = true;
      const byteLength =
        file.encoding === "base64"
          ? (file.data.length / 4) * 3 -
            (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0)
          : Buffer.byteLength(file.data, "utf8");
      if (byteLength > importLimits.fileBytes || totalBytes + byteLength > importLimits.totalBytes)
        throw new Error(`Material byte limit exceeded: ${file.path}`);
      if (
        file.encoding === "base64" &&
        (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
      )
        throw new Error(`Invalid base64 data: ${file.path}`);
      const content = Buffer.from(file.data, file.encoding === "base64" ? "base64" : "utf8");
      if (file.encoding === "base64" && content.toString("base64") !== file.data)
        throw new Error(`Noncanonical base64 data: ${file.path}`);
      if (
        content.length > importLimits.fileBytes ||
        totalBytes + content.length > importLimits.totalBytes
      )
        throw new Error(`Material byte limit exceeded: ${file.path}`);
      totalBytes += content.length;
      const sha256 = digest(content);
      let declaration = declarations[key];
      if (declaration) {
        if (
          declaration.state !== "present" ||
          declaration.role !== file.role ||
          declaration.required !== file.required ||
          declaration.mode !== file.mode
        )
          throw new Error(`Uploaded material metadata conflicts with manifest: ${file.path}`);
        if (declaration.sha256 && declaration.sha256 !== sha256)
          throw new Error(`Material hash mismatch: ${file.path}`);
      } else {
        declaration = {
          workspaceId: file.workspaceId,
          path: file.path,
          role: file.role,
          required: file.required,
          mode: file.mode,
          state: "present",
        };
        declarations[key] = declaration;
      }
      const id = `material-${digest(key)}`;
      bytes[id] = content;
      hashes[id] = sha256;
    }
    if (Object.keys(declarations).length > importLimits.files)
      throw new Error("Material file count limit exceeded");
    const materials: PreviewMaterial[] = [];
    manifest.materials = Object.entries(declarations)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, declaration]) => {
        const id = `material-${digest(key)}`;
        const content = bytes[id];
        const state = declaration.state === "present" && !content ? "missing" : declaration.state;
        const normalized = { ...declaration, state };
        materials.push({
          id,
          workspaceId: declaration.workspaceId,
          path: declaration.path,
          role: declaration.role,
          required: declaration.required,
          mode: declaration.mode,
          state,
          sha256: hashes[id] ?? null,
          bytes: content?.length ?? 0,
        });
        return normalized;
      });
    const paths: Record<string, true> = Object.create(null);
    for (const material of materials)
      paths[JSON.stringify([material.workspaceId, material.path])] = true;
    for (const material of materials) {
      const parts = material.path.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (paths[JSON.stringify([material.workspaceId, parts.slice(0, index).join("/")])])
          throw new Error(`File/directory material path conflict: ${material.path}`);
      }
    }
    const source = manifest.source.groupId ? this.source(manifest.source.groupId) : null;
    if (!source && manifest.source.reference) {
      const linked = this.store.db
        .query("SELECT id FROM import_sources WHERE kind=? AND reference=?")
        .all(manifest.source.kind, manifest.source.reference) as { id: string }[];
      if (linked.length)
        throw new Error(
          `Source reference already exists; explicitly select source.groupId: ${linked.map((row) => row.id).join(", ")}`,
        );
    }
    if (
      source &&
      (source.kind !== manifest.source.kind || source.reference !== manifest.source.reference)
    )
      throw new Error("Source group identity conflicts with source kind/reference");
    const warnings = [
      "sensitive_material_review_required",
      "import_does_not_execute_commands",
      ...payload.warnings,
    ];
    for (const workspace of manifest.workspaces) {
      if (workspace.revision) warnings.push(`snapshot_revision_unverified:${workspace.id}`);
      if (workspace.snapshot === "original")
        warnings.push(`snapshot_original_user_declared:${workspace.id}`);
    }
    const blockers: string[] = [];
    const present = materials.filter((material) => material.state === "present");
    const requiresMaterials =
      manifest.workspaces.some((workspace) => workspace.required) ||
      materials.some((material) => material.required && material.state !== "deleted");
    const requiresInput =
      manifest.workspaces.some((workspace) => workspace.required) ||
      materials.some(
        (material) =>
          material.role === "input" && material.required && material.state !== "deleted",
      );
    if (requiresMaterials && !present.length) blockers.push("missing_materials");
    if (requiresInput && !present.some((material) => material.role === "input"))
      blockers.push("missing_input_materials");
    if (!manifest.instruction.trim()) blockers.push("missing_instruction");
    for (const material of materials) {
      if (material.state === "missing") {
        if (material.required) blockers.push(`missing_required_material:${material.path}`);
        else warnings.push(`optional_material_missing:${material.path}`);
      }
      if (material.state === "present" && ignoredPath(material.path))
        warnings.push(`explicit_sensitive_file_requires_review:${material.path}`);
    }
    let baselineDeclared = true;
    for (const workspace of manifest.workspaces) {
      if (!workspace.required) continue;
      const hasInput = present.some(
        (material) => material.workspaceId === workspace.id && material.role === "input",
      );
      if (!hasInput) blockers.push(`missing_workspace_materials:${workspace.id}`);
      if (
        !hasInput ||
        workspace.snapshot === "missing" ||
        workspace.snapshot === "unknown" ||
        (manifest.start.kind === "original" && workspace.snapshot !== "original")
      ) {
        baselineDeclared = false;
        blockers.push(`missing_start_snapshot:${workspace.id}`);
      }
    }
    if (!baselineDeclared) blockers.push("missing_start_snapshot");
    const acceptanceDefined =
      manifest.acceptance.kind !== "unspecified" && Boolean(manifest.acceptance.description.trim());
    if (!acceptanceDefined) blockers.push("acceptance_not_defined");
    for (const missing of manifest.missing) blockers.push(`missing_declared:${missing}`);
    if (source?.purpose === "improvement" || manifest.source.usedForImprovement)
      warnings.push("source_group_exposed_for_improvement");
    if (source?.purpose === "improvement" && !manifest.source.usedForImprovement)
      warnings.push("source_validation_conflict_requires_confirmation_and_reason");
    if (source?.purpose === "validation" && manifest.source.usedForImprovement)
      warnings.push("source_exposure_requires_confirmation_and_reason");
    const materialsComplete = !blockers.some(
      (blocker) =>
        blocker === "missing_materials" ||
        blocker === "missing_input_materials" ||
        blocker.startsWith("missing_required_material:") ||
        blocker.startsWith("missing_workspace_materials:") ||
        blocker.startsWith("missing_declared:"),
    );
    blockers.push("executor_not_connected");
    const readiness: Readiness = {
      materialsComplete,
      baselineDeclared,
      acceptanceDefined,
      executionSupported: false,
      blockers,
      warnings,
    };
    const approvalDigest = digest(
      JSON.stringify({
        format: "detroit.case-import/1",
        manifest,
        materials,
        warnings,
        source: source
          ? {
              id: source.id,
              kind: source.kind,
              reference: source.reference,
              description: source.description,
              purpose: source.purpose,
              exposedAt: source.exposed_at,
              createdAt: source.created_at,
            }
          : null,
      }),
    );
    return {
      preview: {
        approvalDigest,
        manifest,
        materials,
        fileCount: present.length,
        totalBytes,
        readiness,
        warnings,
      },
      bytes,
    };
  }

  preview(payload: unknown): ImportPreview {
    return this.normalize(payload).preview;
  }

  async prepareLocal(manifestPath: string, sourceGroupId?: string): Promise<ImportPayload> {
    const absolute = resolve(manifestPath);
    const filesystemRoot = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
    let root: FileHandle;
    try {
      root = await openWithin(filesystemRoot, dirname(absolute).split("/").filter(Boolean), true);
    } finally {
      await filesystemRoot.close();
    }
    try {
      const manifestHandle = await openWithin(root, [basename(absolute)], false);
      let raw: unknown;
      try {
        raw = JSON.parse(
          (
            await readStable(manifestHandle, basename(absolute), importLimits.payloadBytes)
          ).toString("utf8"),
        );
      } finally {
        await manifestHandle.close();
      }
      // Accept either a plain manifest or the same payload accepted by the Web API.
      const payload = importPayloadSchema.parse(
        typeof raw === "object" && raw !== null && Object.hasOwn(raw, "manifest")
          ? raw
          : { manifest: raw },
      );
      if (sourceGroupId !== undefined) payload.manifest.source.groupId = sourceGroupId;
      const declarations: Record<string, ImportManifest["materials"][number]> = Object.create(null);
      for (const declaration of payload.manifest.materials) {
        const key = JSON.stringify([declaration.workspaceId, declaration.path]);
        if (declarations[key]) throw new Error(`Duplicate material: ${declaration.path}`);
        declarations[key] = declaration;
      }
      let totalBytes = payload.files.reduce(
        (sum, file) =>
          sum + Buffer.byteLength(file.data, file.encoding === "base64" ? "base64" : "utf8"),
        0,
      );
      let entries = 0;
      const add = async (
        handle: FileHandle,
        workspaceId: string | null,
        path: string,
      ): Promise<void> => {
        logicalPath(path);
        if (payload.files.length >= importLimits.files)
          throw new Error("Material file count limit exceeded");
        const content = await readStable(
          handle,
          path,
          Math.min(importLimits.fileBytes, importLimits.totalBytes - totalBytes),
        );
        totalBytes += content.length;
        const key = JSON.stringify([workspaceId, path]);
        const declaration = declarations[key];
        if (declaration?.state === "deleted")
          throw new Error(`Deleted material is present in snapshot: ${path}`);
        const mode = (await handle.stat()).mode & 0o777;
        const file: UploadedFile = {
          workspaceId,
          path,
          data: content.toString("base64"),
          encoding: "base64",
          role: declaration?.role ?? "input",
          required: declaration?.required ?? true,
          mode,
        };
        if (declaration) {
          declaration.state = "present";
          declaration.mode = mode;
        }
        payload.files.push(file);
      };
      const walk = async (
        handle: FileHandle,
        workspaceId: string,
        prefix: string,
      ): Promise<void> => {
        const before = await handle.stat();
        const directory = await opendir(`/proc/self/fd/${handle.fd}`);
        for await (const entry of directory) {
          if (++entries > importLimits.files * 2)
            throw new Error("Local directory entry limit exceeded");
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (ignoredPath(path)) {
            payload.warnings.push(`local_path_ignored:${workspaceId}/${path}`);
            continue;
          }
          logicalPath(path);
          const initial = await lstat(`/proc/self/fd/${handle.fd}/${entry.name}`);
          if (initial.isSymbolicLink() || (!initial.isDirectory() && !initial.isFile()))
            throw new Error(
              `Symlinks and special files cannot be imported: ${workspaceId}/${path}`,
            );
          const child = await openWithin(handle, [entry.name], initial.isDirectory());
          try {
            const checked = await child.stat();
            if (
              checked.dev !== initial.dev ||
              checked.ino !== initial.ino ||
              checked.mode !== initial.mode
            )
              throw new Error(`Source changed during import; retry preview: ${path}`);
            if (checked.isDirectory()) await walk(child, workspaceId, path);
            else await add(child, workspaceId, path);
          } finally {
            await child.close();
          }
        }
        const after = await handle.stat();
        if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
          throw new Error(
            `Directory changed during import; retry preview: ${prefix || workspaceId}`,
          );
      };
      for (const workspace of payload.manifest.workspaces) {
        if (workspace.path === undefined) continue;
        const path = workspace.path;
        const parts = localPath(path);
        delete workspace.path;
        if (ignoredPath(path)) throw new Error(`Workspace path is reserved or sensitive: ${path}`);
        let handle: FileHandle;
        try {
          handle = await openWithin(root, parts, true);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
          workspace.snapshot = "missing";
          payload.warnings.push(`local_workspace_missing:${workspace.id}`);
          continue;
        }
        try {
          await walk(handle, workspace.id, "");
        } finally {
          await handle.close();
        }
        payload.warnings.push(`local_snapshot_non_atomic:${workspace.id}`);
      }
      for (const material of payload.manifest.materials) {
        if (material.sourcePath === undefined) continue;
        const path = material.sourcePath;
        const parts = localPath(path);
        delete material.sourcePath;
        if (material.state === "deleted") continue;
        if (ignoredPath(path)) {
          material.state = "missing";
          payload.warnings.push(`local_path_ignored:${path}`);
          continue;
        }
        if (
          payload.files.some(
            (file) => file.workspaceId === material.workspaceId && file.path === material.path,
          )
        )
          throw new Error(`Material has both workspace and sourcePath content: ${material.path}`);
        let handle: FileHandle;
        try {
          handle = await openWithin(root, parts, false);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
          material.state = "missing";
          payload.warnings.push(`local_material_missing:${material.path}`);
          continue;
        }
        try {
          await add(handle, material.workspaceId, material.path);
        } finally {
          await handle.close();
        }
      }
      // Directory enumeration order is not part of the approved snapshot.
      payload.files.sort((left, right) => {
        const a = JSON.stringify([left.workspaceId, left.path]);
        const b = JSON.stringify([right.workspaceId, right.path]);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      payload.warnings.sort();
      this.preview(payload);
      return payload;
    } finally {
      await root.close();
    }
  }

  private expose(
    sourceId: string,
    caseId: string | null,
    confirmation: { confirmExposure?: boolean; exposureReason?: string },
  ): void {
    if (!confirmation.confirmExposure || !confirmation.exposureReason?.trim())
      throw new Error(
        "Source validation conflict: confirmExposure=true and a nonblank exposureReason are required to use the entire source group for improvement",
      );
    const now = new Date().toISOString();
    this.store.db
      .query(
        "UPDATE import_sources SET purpose='improvement',exposed_at=COALESCE(exposed_at,?) WHERE id=?",
      )
      .run(now, sourceId);
    this.store.db
      .query("INSERT INTO import_exposures VALUES (?,?,?,?,?)")
      .run(randomUUID(), sourceId, caseId, confirmation.exposureReason.trim(), now);
  }

  confirm(payload: unknown, confirmation: ImportConfirmation): ImportedCase {
    const approved = confirmationSchema.parse(confirmation);
    return this.store.db
      .transaction(() => {
        const { preview, bytes } = this.normalize(payload);
        if (preview.approvalDigest !== approved.approvalDigest)
          throw new Error(
            "Approval digest mismatch: material, manifest, roles, or source state changed; preview and approve again",
          );
        const existing = approved.caseId !== undefined ? this.get(approved.caseId) : null;
        if (
          existing &&
          (approved.expectedRevision === undefined ||
            approved.expectedRevision !== existing.revision)
        )
          throw new Error(
            "Stale case revision: provide expectedRevision matching the latest revision and preview again",
          );
        if (!existing && approved.expectedRevision !== undefined)
          throw new Error("expectedRevision requires caseId");
        if (existing && preview.manifest.source.groupId !== existing.sourceGroupId)
          throw new Error(
            "Updating a case requires its existing sourceGroupId in manifest.source.groupId",
          );
        if (existing && preview.manifest.start.kind !== existing.manifest.start.kind)
          throw new Error(
            "Changing original/current start requires a new linked case: omit caseId and reuse manifest.source.groupId",
          );
        const collection =
          approved.collectionId !== undefined ? this.collection(approved.collectionId) : null;
        const now = new Date().toISOString();
        const caseId = existing?.id ?? `case-${randomUUID()}`;
        const sourceId = preview.manifest.source.groupId ?? `source-${randomUUID()}`;
        if (!preview.manifest.source.groupId) {
          const used = preview.manifest.source.usedForImprovement;
          this.store.db
            .query("INSERT INTO import_sources VALUES (?,?,?,?,?,?,?)")
            .run(
              sourceId,
              preview.manifest.source.kind,
              preview.manifest.source.reference,
              preview.manifest.source.description,
              used ? "improvement" : "validation",
              used ? now : null,
              now,
            );
        }
        if (!existing)
          this.store.db.query("INSERT INTO import_cases VALUES (?,?,?)").run(caseId, sourceId, now);
        const source = this.source(sourceId);
        if (
          (source.purpose === "improvement" && !preview.manifest.source.usedForImprovement) ||
          (source.purpose === "validation" &&
            (preview.manifest.source.usedForImprovement || collection?.purpose === "improvement"))
        )
          this.expose(sourceId, caseId, approved);
        if (collection?.purpose === "validation" && this.source(sourceId).purpose !== "validation")
          throw new Error(
            "Validation collection cannot include a source group exposed for improvement",
          );
        const draftId = `draft-${randomUUID()}`;
        const revision = (existing?.revision ?? 0) + 1;
        this.store.db
          .query("INSERT INTO import_drafts VALUES (?,?,?,?,?,?,?)")
          .run(
            draftId,
            caseId,
            revision,
            JSON.stringify(preview.manifest),
            JSON.stringify(preview.readiness),
            preview.approvalDigest,
            now,
          );
        for (const workspace of preview.manifest.workspaces)
          this.store.db
            .query("INSERT INTO import_workspaces VALUES (?,?,?,?,?,?)")
            .run(
              draftId,
              workspace.id,
              workspace.name,
              workspace.revision,
              workspace.snapshot,
              Number(workspace.required),
            );
        for (const material of preview.materials) {
          if (material.sha256) {
            this.store.db
              .query("INSERT OR IGNORE INTO import_blobs VALUES (?,?)")
              .run(material.sha256, bytes[material.id]!);
            const blob = this.store.db
              .query("SELECT bytes FROM import_blobs WHERE sha256=?")
              .get(material.sha256) as { bytes: Uint8Array };
            if (digest(blob.bytes) !== material.sha256)
              throw new Error("Stored material digest mismatch");
          }
          this.store.db
            .query("INSERT INTO import_materials VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(
              draftId,
              material.id,
              material.workspaceId,
              material.path,
              material.role,
              Number(material.required),
              material.mode,
              material.state,
              material.sha256,
              material.bytes,
            );
        }
        if (collection)
          this.store.db
            .query(
              "INSERT INTO import_members VALUES (?,?,?,?,?) ON CONFLICT(collection_id,case_id) DO UPDATE SET draft_id=excluded.draft_id,revision=excluded.revision,weight=excluded.weight",
            )
            .run(collection.id, caseId, draftId, revision, approved.weight);
        return this.get(caseId, revision);
      })
      .immediate();
  }

  list(): ImportedCase[] {
    const rows = this.store.db
      .query("SELECT id FROM import_cases ORDER BY created_at,id")
      .all() as { id: string }[];
    return rows.map((row) => this.get(row.id));
  }

  get(caseId: string, revision?: number): ImportedCase {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new Error("Revision must be a positive integer");
    const row = this.store.db
      .query(`
      SELECT d.*,c.source_group_id FROM import_drafts d JOIN import_cases c ON c.id=d.case_id
      WHERE c.id=? ${revision === undefined ? "" : "AND d.revision=?"} ORDER BY d.revision DESC LIMIT 1
    `)
      .get(...(revision === undefined ? [caseId] : [caseId, revision])) as DraftRow | null;
    if (!row)
      throw new Error(
        `Unknown case/revision: ${caseId}${revision === undefined ? "" : `@${revision}`}`,
      );
    const readiness = readinessSchema.parse(JSON.parse(row.readiness_json));
    if (
      this.source(row.source_group_id).purpose === "improvement" &&
      !readiness.warnings.includes("source_group_exposed_for_improvement")
    )
      readiness.warnings.push("source_group_exposed_for_improvement");
    const materials = (
      this.store.db
        .query(
          "SELECT * FROM import_materials WHERE draft_id=? ORDER BY COALESCE(workspace_id,''),path",
        )
        .all(row.id) as MaterialRow[]
    ).map(metadata);
    return {
      id: row.case_id,
      draftId: row.id,
      revision: row.revision,
      sourceGroupId: row.source_group_id,
      createdAt: row.created_at,
      manifest: importManifestSchema.parse(JSON.parse(row.manifest_json)),
      materials,
      readiness,
      approvalDigest: row.approval_digest,
    };
  }

  sourceGroups(): SourceGroup[] {
    return (
      this.store.db
        .query("SELECT * FROM import_sources ORDER BY created_at,id")
        .all() as SourceRow[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      reference: row.reference,
      description: row.description,
      purpose: row.purpose,
      exposedAt: row.exposed_at,
      createdAt: row.created_at,
    }));
  }

  private collection(id: string): CaseCollection {
    const row = this.store.db.query("SELECT * FROM import_collections WHERE id=?").get(id) as {
      id: string;
      name: string;
      purpose: CaseCollection["purpose"];
      regression: number;
      created_at: string;
    } | null;
    if (!row) throw new Error(`Unknown collection: ${id}`);
    const entries = this.store.db
      .query(
        "SELECT case_id AS caseId,draft_id AS draftId,revision,weight FROM import_members WHERE collection_id=? ORDER BY case_id",
      )
      .all(id) as CaseCollection["entries"];
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      regression: Boolean(row.regression),
      createdAt: row.created_at,
      entries,
    };
  }

  collections(): CaseCollection[] {
    const rows = this.store.db
      .query("SELECT id FROM import_collections ORDER BY created_at,id")
      .all() as { id: string }[];
    return rows.map((row) => this.collection(row.id));
  }

  createCollection(input: {
    name: string;
    purpose: "improvement" | "validation";
    regression?: boolean;
  }): CaseCollection {
    const parsed = collectionInputSchema.parse(input);
    if (!parsed.name.trim()) throw new Error("Collection name must not be blank");
    const id = `collection-${randomUUID()}`;
    this.store.db
      .query("INSERT INTO import_collections VALUES (?,?,?,?,?)")
      .run(id, parsed.name, parsed.purpose, Number(parsed.regression), new Date().toISOString());
    return this.collection(id);
  }

  addToCollection(
    caseId: string,
    collectionId: string,
    options: {
      revision?: number;
      weight?: number;
      confirmExposure?: boolean;
      exposureReason?: string;
    } = {},
  ): CaseCollection {
    const parsed = collectionMemberSchema.parse({ ...options, caseId });
    return this.store.db
      .transaction(() => {
        const imported = this.get(caseId, parsed.revision);
        const collection = this.collection(collectionId);
        const source = this.source(imported.sourceGroupId);
        if (collection.purpose === "validation" && source.purpose !== "validation")
          throw new Error(
            "Validation collection cannot include a source group exposed for improvement",
          );
        if (collection.purpose === "improvement" && source.purpose === "validation")
          this.expose(source.id, caseId, parsed);
        this.store.db
          .query(
            "INSERT INTO import_members VALUES (?,?,?,?,?) ON CONFLICT(collection_id,case_id) DO UPDATE SET draft_id=excluded.draft_id,revision=excluded.revision,weight=excluded.weight",
          )
          .run(collectionId, caseId, imported.draftId, imported.revision, parsed.weight);
        return this.collection(collectionId);
      })
      .immediate();
  }

  material(
    caseId: string,
    materialId: string,
    revision?: number,
  ): { metadata: PreviewMaterial; bytes: Buffer<ArrayBuffer> } {
    const imported = this.get(caseId, revision);
    const material = imported.materials.find((item) => item.id === materialId);
    if (!material) throw new Error("Material does not belong to this case revision");
    if (!material.sha256 || material.state !== "present")
      throw new Error("Material has no approved bytes");
    const row = this.store.db
      .query("SELECT bytes FROM import_blobs WHERE sha256=?")
      .get(material.sha256) as { bytes: Uint8Array } | null;
    if (!row || digest(row.bytes) !== material.sha256 || row.bytes.length !== material.bytes)
      throw new Error("Stored material digest mismatch");
    return { metadata: material, bytes: Buffer.from(row.bytes) };
  }
}
