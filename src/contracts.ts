import { z } from "zod";

export const protocolVersion = 1;
export const harnessVersion = "reference/0.1.0";
export const budgetsSchema = z.object({
  modelCalls: z.number().int().positive().default(12),
  toolCalls: z.number().int().positive().default(30),
  totalTokens: z.number().int().positive().default(100_000),
  deadlineMs: z.number().int().positive().default(180_000),
  contextTokens: z.number().int().positive().default(32_000),
  outputTokens: z.number().int().positive().default(2048),
  safetyTokens: z.number().int().nonnegative().default(1024),
});
export type Budgets = z.infer<typeof budgetsSchema>;
// "external": model calls are owned by the driver/external harness (e.g. OMP),
// not by Detroit. No key is injected; deep usage observability is limited.
export const variantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  driver: z.enum(["reference", "omp"]).default("reference"),
  provider: z.enum(["scripted-repair", "scripted-noop", "openai", "external"]),
  model: z.string().default("gpt-4.1-mini"),
  baseURL: z.url().default("https://api.openai.com/v1"),
  temperature: z.number().min(0).max(2).default(0),
  budgets: budgetsSchema.default(() => budgetsSchema.parse({})),
});
export type Variant = z.infer<typeof variantSchema>;

export const driverConfigurationSchema = z.object({
  requested: variantSchema,
  applied: z.record(z.string(), z.unknown()),
  observed: z.record(z.string(), z.unknown()),
  unknown: z.array(z.string()),
  unsupported: z.array(z.string()),
  provenance: z.record(z.string(), z.string()),
});
export type DriverConfiguration = z.infer<typeof driverConfigurationSchema>;
/** Declares implemented controls, not a claim that a provider honored them. */
export function driverConfiguration(variant: Variant): DriverConfiguration {
  if (variant.driver === "omp") {
    const unsupported = [
      "provider",
      "baseURL",
      "temperature",
      "budgets.modelCalls",
      "budgets.toolCalls",
      "budgets.totalTokens",
      "budgets.contextTokens",
      "budgets.outputTokens",
      "budgets.safetyTokens",
    ];
    return {
      requested: variant,
      applied: { model: variant.model, "budgets.deadlineMs": variant.budgets.deadlineMs },
      observed: {},
      unknown: ["model", ...unsupported],
      unsupported,
      provenance: {
        model: "OMP CLI --model selector; resolved model requires RPC observation",
        "budgets.deadlineMs": "Detroit supervisor deadline; OMP subprocess cancelled",
      },
    };
  }
  return {
    requested: variant,
    applied: {
      provider: variant.provider,
      model: variant.model,
      baseURL: variant.baseURL,
      temperature: variant.temperature,
      budgets: variant.budgets,
    },
    observed: {},
    unknown: [],
    unsupported: [],
    provenance: {
      applied: "Detroit reference harness controls; provider behavior separately observed",
    },
  };
}
export const experimentSchema = z
  .object({
    name: z.string().min(1),
    sandbox: z
      .object({
        kind: z.literal("bubblewrap").default("bubblewrap"),
        network: z.enum(["none", "host"]).default("none"),
      })
      .strict()
      .default({ kind: "bubblewrap", network: "none" }),
    cases: z.array(z.string()).min(1),
    variants: z.array(variantSchema).min(1),
    repeats: z.number().int().min(1).max(10).default(1),
    seed: z.number().int().default(42),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const ids of [spec.cases, spec.variants.map((v) => v.id)]) {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "Duplicate case/variant ID" });
    }
    if (spec.variants.some((v) => v.provider === "openai") && spec.sandbox.network !== "host")
      ctx.addIssue({
        code: "custom",
        message: "OpenAI requires explicit sandbox.network=host (shares host networking)",
      });
  });
export type ExperimentSpec = z.infer<typeof experimentSchema>;

export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.literal(1),
  family: z.string(),
  split: z.literal("dev"),
  source: z.literal("Detroit original synthetic fixture"),
  instruction: z.string(),
  files: z.record(z.string(), z.string()),
  entrypoint: z.string(),
  exportName: z.string(),
  checks: z
    .array(z.object({ name: z.string(), args: z.array(z.unknown()), expected: z.unknown() }))
    .min(1),
  solution: z.string(),
});
export type Case = z.infer<typeof caseSchema>;

export type ToolCall = { id: string; name: string; arguments: string };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; content: string; callId: string };
export type Usage = { input: number; output: number; source: "provider" } | null;
export type ModelResponse = {
  id: string | null;
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
};
export type StopReason =
  | "final_response"
  | "budget"
  | "deadline"
  | "stalled"
  | "error"
  | "cancelled";
export type RunResult = {
  stopReason: StopReason;
  modelCalls: number;
  toolCalls: number;
  knownTokens: number;
  usageComplete: boolean;
  costUSD: number | null;
  elapsedMs: number;
  finalOutput?: string;
  counterSource?: string;
  usageSource?: string;
  countersComplete?: boolean;
  evidenceComplete?: boolean;
};
export const eventSchema = z.object({
  schema_version: z.literal(1),
  attempt_id: z.string(),
  source_id: z.enum(["reference", "omp"]),
  source_seq: z.number().int().positive(),
  event_type: z.string(),
  observed_at: z.string(),
  raw_ref: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EvidenceEvent = z.infer<typeof eventSchema>;
export const evaluationSchema = z.object({
  version: z.literal("deterministic/1"),
  status: z.enum(["pass", "fail", "evaluation_error"]),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string(),
    }),
  ),
  error: z.string().nullable(),
});
export type Evaluation = z.infer<typeof evaluationSchema>;
export const driverRequestSchema = z.object({
  protocol_version: z.literal(1),
  attempt_id: z.string(),
  instruction: z.string(),
  variant: variantSchema,
  // Supplied only to synthetic contract runs; never to a real provider.
  script: z
    .array(
      z.object({
        content: z.string(),
        toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })),
      }),
    )
    .optional(),
});
export type DriverRequest = z.infer<typeof driverRequestSchema>;
export const driverFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    protocol_version: z.literal(1),
    // Different drivers report their own harness version (reference vs OMP shim).
    harness_version: z.string(),
  }),
  z.object({
    type: z.literal("accepted"),
    attempt_id: z.string(),
    configuration: driverConfigurationSchema,
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({
      stopReason: z.enum(["final_response", "budget", "deadline", "stalled", "error", "cancelled"]),
      modelCalls: z.number(),
      toolCalls: z.number(),
      knownTokens: z.number(),
      usageComplete: z.boolean(),
      costUSD: z.number().finite().nonnegative().nullable(),
      elapsedMs: z.number(),
      finalOutput: z.string().optional(),
      counterSource: z.string().optional(),
      usageSource: z.string().optional(),
      countersComplete: z.boolean().optional(),
      evidenceComplete: z.boolean().optional(),
    }),
    configuration: driverConfigurationSchema.optional(),
  }),
]);
