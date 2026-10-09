import { z } from "zod";

export const importLimits = {
  files: 10000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  payloadBytes: 100 * 1024 * 1024,
};
export const materialRoleSchema = z.enum(["input", "diagnostic", "scoring"]);
export type MaterialRole = z.infer<typeof materialRoleSchema>;
export const sourceSchema = z
  .object({
    groupId: z.string().optional(),
    kind: z.enum(["oncall", "issue", "session", "manual"]),
    reference: z.string().default(""),
    description: z.string().default(""),
    usedForImprovement: z.boolean().default(false),
  })
  .strict();
export const workspaceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    revision: z.string().nullable().default(null),
    snapshot: z.enum(["original", "current", "unknown", "missing"]).default("unknown"),
    path: z.string().optional(),
    required: z.boolean().default(true),
  })
  .strict();
export const materialDeclarationSchema = z
  .object({
    workspaceId: z.string().nullable().default(null),
    path: z.string().min(1),
    role: materialRoleSchema.default("input"),
    required: z.boolean().default(true),
    sourcePath: z.string().optional(),
    state: z.enum(["present", "missing", "deleted"]).default("present"),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mode: z.number().int().min(0).max(0o777).default(0o644),
  })
  .strict();
export const importManifestSchema = z
  .object({
    kind: z.literal("detroit.case"),
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(500),
    instruction: z.string().max(100000),
    source: sourceSchema,
    start: z
      .object({ kind: z.enum(["original", "current"]), description: z.string().default("") })
      .strict(),
    workspaces: z.array(workspaceSchema).default([]),
    materials: z.array(materialDeclarationSchema).default([]),
    environment: z
      .object({
        requirements: z.array(z.string()).default([]),
        preparation: z.array(z.string()).default([]),
        network: z.enum(["none", "host"]).default("none"),
        credentials: z.array(z.string()).default([]),
      })
      .strict()
      .default({ requirements: [], preparation: [], network: "none", credentials: [] }),
    output: z
      .object({
        description: z.string().default(""),
        format: z.enum(["text", "json", "files", "mixed"]).default("text"),
      })
      .strict()
      .default({ description: "", format: "text" }),
    acceptance: z
      .object({
        kind: z.enum(["unspecified", "manual", "command", "structured"]).default("unspecified"),
        description: z.string().default(""),
      })
      .strict()
      .default({ kind: "unspecified", description: "" }),
    missing: z.array(z.string()).default([]),
  })
  .strict();
export type ImportManifest = z.infer<typeof importManifestSchema>;
export const uploadedFileSchema = z
  .object({
    workspaceId: z.string().nullable().default(null),
    path: z.string(),
    data: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    role: materialRoleSchema.default("input"),
    required: z.boolean().default(true),
    mode: z.number().int().min(0).max(0o777).default(0o644),
  })
  .strict();
export type UploadedFile = z.infer<typeof uploadedFileSchema>;
export const importPayloadSchema = z
  .object({
    manifest: importManifestSchema,
    files: z.array(uploadedFileSchema).max(importLimits.files).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .strict();
export type ImportPayload = z.infer<typeof importPayloadSchema>;
export type PreviewMaterial = {
  id: string;
  workspaceId: string | null;
  path: string;
  role: MaterialRole;
  required: boolean;
  mode: number;
  state: "present" | "missing" | "deleted";
  sha256: string | null;
  bytes: number;
};
export const readinessSchema = z
  .object({
    materialsComplete: z.boolean(),
    baselineDeclared: z.boolean(),
    acceptanceDefined: z.boolean(),
    executionSupported: z.literal(false),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
export type Readiness = z.infer<typeof readinessSchema>;
export type ImportPreview = {
  approvalDigest: string;
  manifest: ImportManifest;
  materials: PreviewMaterial[];
  fileCount: number;
  totalBytes: number;
  readiness: Readiness;
  warnings: string[];
};
export type SourceGroup = {
  id: string;
  kind: ImportManifest["source"]["kind"];
  reference: string;
  description: string;
  purpose: "improvement" | "validation";
  exposedAt: string | null;
  createdAt: string;
};
export type ImportedCase = {
  id: string;
  draftId: string;
  revision: number;
  sourceGroupId: string;
  createdAt: string;
  manifest: ImportManifest;
  materials: PreviewMaterial[];
  readiness: Readiness;
  approvalDigest: string;
};
export type CaseCollection = {
  id: string;
  name: string;
  purpose: "improvement" | "validation";
  regression: boolean;
  createdAt: string;
  entries: { caseId: string; draftId: string; revision: number; weight: number }[];
};
export type ImportConfirmation = {
  approvalDigest: string;
  approved: boolean;
  collectionId?: string;
  caseId?: string;
  expectedRevision?: number;
  weight?: number;
  confirmExposure?: boolean;
  exposureReason?: string;
};
export const confirmationSchema = z
  .object({
    approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approved: z.literal(true),
    collectionId: z.string().optional(),
    caseId: z.string().optional(),
    expectedRevision: z.number().int().positive().optional(),
    weight: z.number().finite().nonnegative().default(1),
    confirmExposure: z.boolean().default(false),
    exposureReason: z.string().optional(),
  })
  .strict();
export const collectionInputSchema = z
  .object({
    name: z.string().min(1).max(500),
    purpose: z.enum(["improvement", "validation"]),
    regression: z.boolean().default(false),
  })
  .strict();
export const collectionMemberSchema = z
  .object({
    caseId: z.string().min(1),
    revision: z.number().int().positive().optional(),
    weight: z.number().finite().nonnegative().default(1),
    confirmExposure: z.boolean().default(false),
    exposureReason: z.string().optional(),
  })
  .strict();
export const importRequestSchema = z
  .object({ payload: importPayloadSchema, confirmation: confirmationSchema })
  .strict();
