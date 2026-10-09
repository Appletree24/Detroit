import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCase, repairScript } from "./cases";
import { type Case, type DriverRequest, type ExperimentSpec, harnessVersion } from "./contracts";
import { evaluationError } from "./eval/verifier";
import { digest, Evidence } from "./evidence";
import { systemPrompt } from "./harness/runtime";
import { Bubblewrap, type SandboxEnvironment } from "./sandbox/bubblewrap";
import { artifactDigest } from "./sandbox/files";
import { SandboxCleanupError } from "./sandbox/lifecycle";
import type { Store, TrialRow } from "./store";

export type FrozenExperiment = {
  spec: ExperimentSpec;
  cases: Case[];
  environment: SandboxEnvironment;
  harnessVersion: string | null;
  bunVersion: string;
  systemPrompt: string | null;
  driverDigests: Record<string, string>;
  verifierDigest: string;
  policy: {
    retry: "none";
    order: "seeded-case-blocks";
    concurrency: 1;
    context: "full-history/1" | null;
  };
};
async function verifierVersion(bundle: string) {
  return digest(
    JSON.stringify({
      worker: digest(await readFile(bundle)),
      supervisor: digest(await readFile(join(import.meta.dir, "eval/verifier.ts"))),
    }),
  );
}
export function schedule(experimentId: string, spec: ExperimentSpec): TrialRow[] {
  let state = spec.seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const trials: TrialRow[] = [];
  for (const id of spec.cases) {
    for (let repeat = 0; repeat < spec.repeats; repeat++) {
      const variants = [...spec.variants];
      for (let i = variants.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [variants[i], variants[j]] = [variants[j]!, variants[i]!];
      }
      for (const variant of variants)
        trials.push({
          id: `${experimentId}-${trials.length + 1}`,
          experiment_id: experimentId,
          case_id: id,
          variant_id: variant.id,
          repeat_index: repeat,
          ordinal: trials.length,
        });
    }
  }
  return trials;
}

export async function runExperiment(
  spec: ExperimentSpec,
  store: Store,
  project: string,
  signal: AbortSignal,
  sandbox = new Bubblewrap(),
): Promise<string> {
  const environment = await sandbox.doctor();
  const active = store.active();
  if (active.length)
    throw new Error(
      "Unreconciled attempts exist. Run detroit recover before creating another experiment.",
    );
  const driverPaths = {
    reference: join(project, "dist/reference.js"),
    omp: join(project, "dist/omp.js"),
  };
  const verifier = join(project, "dist/verifier.js");
  const items = spec.cases.map(getCase);
  const apiKey = process.env.OPENAI_API_KEY;
  if (spec.variants.some((v) => v.provider === "openai") && !apiKey)
    throw new Error("OPENAI_API_KEY is required");
  const driverDigests: Record<string, string> = {};
  for (const name of [...new Set(spec.variants.map((v) => v.driver))])
    driverDigests[name] = digest(await readFile(driverPaths[name]));
  const referenceOnly = spec.variants.every((variant) => variant.driver === "reference");
  if (!referenceOnly)
    console.warn(
      "OMP applies the model selector and wall deadline only; other requested controls are unsupported/unknown. Reference prompt and context policy are not OMP configuration.",
    );
  const frozen: FrozenExperiment = {
    spec,
    cases: items,
    environment,
    harnessVersion: referenceOnly ? harnessVersion : null,
    bunVersion: Bun.version,
    systemPrompt: referenceOnly ? systemPrompt : null,
    driverDigests,
    verifierDigest: await verifierVersion(verifier),
    policy: {
      retry: "none",
      order: "seeded-case-blocks",
      concurrency: 1,
      context: referenceOnly ? "full-history/1" : null,
    },
  };
  const id = randomUUID();
  const trials = schedule(id, spec);
  store.freeze(id, spec, frozen, trials);
  console.log(`Experiment ${id} · ${trials.length} trials · ${environment.bubblewrap}`);
  const cancelPath = join(store.root, `${id}.cancel`);
  const requested = new AbortController();
  const cancelTimer = setInterval(() => {
    if (existsSync(cancelPath)) requested.abort();
  }, 200);
  const combined = AbortSignal.any([signal, requested.signal]);
  try {
    for (const trial of trials) {
      if (combined.aborted) break;
      const item = items.find((c) => c.id === trial.case_id)!;
      const variant = spec.variants.find((v) => v.id === trial.variant_id)!;
      const attemptId = randomUUID();
      const directory = resolve(store.root, "attempts", attemptId);
      const request: DriverRequest = {
        protocol_version: 1,
        attempt_id: attemptId,
        instruction: item.instruction,
        variant,
        ...(variant.provider === "scripted-repair" ? { script: repairScript(item) } : {}),
      };
      store.start(attemptId, trial.id, directory);
      let cleanup = false;
      let outcome: Awaited<ReturnType<Bubblewrap["run"]>> | undefined;
      try {
        outcome = await sandbox.run({
          item,
          request,
          network: spec.sandbox.network,
          directory,
          bundle: driverPaths[variant.driver],
          signal: combined,
          apiKey:
            variant.provider === "openai"
              ? apiKey
              : variant.driver === "omp"
                ? (process.env.DETROIT_OMP_API_KEY ?? undefined)
                : undefined,
        });
        cleanup = outcome.cleanup;
        const evidence = new Evidence(join(directory, "evidence"), attemptId);
        evidence.emit("experiment.config", {
          requested: variant,
          configuration: outcome.configuration ?? null,
          environment,
          driver: variant.driver,
          network: spec.sandbox.network,
          driverDigest: frozen.driverDigests[variant.driver],
          // Scripted variants are synthetic; OMP/external driving a real model is not.
          synthetic: variant.provider !== "openai" && variant.provider !== "external",
        });
        if (outcome.files) {
          const manifest = {
            files_ref: evidence.put(outcome.files),
            digest: artifactDigest(outcome.files),
            complete: outcome.collection?.workspace.complete ?? true,
            truncated: outcome.collection?.workspace.truncated ?? false,
            missing: outcome.collection?.workspace.missing ?? [],
          };
          await writeFile(join(directory, "artifacts.json"), JSON.stringify(manifest));
          evidence.emit("artifacts.manifest", manifest);
          if (cleanup && !combined.aborted) {
            const evaluation = manifest.complete
              ? await sandbox.verify({
                  item,
                  files: outcome.files,
                  directory,
                  bundle: verifier,
                  id: attemptId,
                  signal: combined,
                })
              : evaluationError(`Artifact collection incomplete: ${manifest.missing.join("; ")}`);
            evidence.emit("evaluation.completed", {
              evaluation,
              verifierDigest: frozen.verifierDigest,
            });
            store.score(
              attemptId,
              manifest.digest,
              digest(
                JSON.stringify({
                  item,
                  verifier: frozen.verifierDigest,
                  environment,
                }),
              ),
              evaluation,
            );
          }
        }
        store.finish(
          attemptId,
          outcome.status,
          outcome.result,
          outcome.error,
          cleanup ? "done" : "pending",
        );
        console.log(
          `${trial.ordinal + 1}/${trials.length} ${item.id} / ${variant.id}: ${outcome.status}, ${store.evaluations(attemptId).at(-1)?.result_json ?? "unscored"}`,
        );
      } catch (error) {
        if (error instanceof SandboxCleanupError) cleanup = false;
        store.finish(
          attemptId,
          outcome?.status ?? (combined.aborted ? "cancelled" : "error"),
          outcome?.result ?? null,
          String(error),
          cleanup ? "done" : "pending",
        );
        console.error(`Attempt ${attemptId}: ${error}`);
      }
      if (!cleanup)
        throw new Error("Cleanup unconfirmed; further dispatch stopped. Run detroit recover.");
    }
  } finally {
    clearInterval(cancelTimer);
  }
  return id;
}

export async function recover(store: Store, sandbox = new Bubblewrap()) {
  await sandbox.doctor();
  for (const attempt of store.active()) {
    const frozen = JSON.parse(
      store.experimentForTrial(attempt.trial_id).spec_json,
    ) as FrozenExperiment;
    if (frozen.environment?.kind !== "bubblewrap")
      throw new Error(
        "Legacy Docker attempt: use the previous Docker runner to clean its data directory.",
      );
    const agentClean = await sandbox.remove(attempt.directory, "agent");
    const verifierClean = await sandbox.remove(attempt.directory, "verifier");
    if (!agentClean || !verifierClean) throw new Error(`Cannot confirm cleanup: ${attempt.id}`);
    if (attempt.status === "running")
      store.finish(
        attempt.id,
        "interrupted",
        null,
        "Previous coordinator exited before terminal commit; evidence may be incomplete",
        "done",
      );
    else store.markClean(attempt.id);
  }
}

export async function rescore(
  id: string,
  store: Store,
  project: string,
  sandbox = new Bubblewrap(),
) {
  const environment = await sandbox.doctor();
  const frozen = JSON.parse(store.experiment(id).spec_json) as FrozenExperiment;
  if (frozen.environment?.kind !== "bubblewrap")
    throw new Error("Legacy Docker experiment cannot be rescored as a Bubblewrap experiment.");
  const bundle = join(project, "dist/verifier.js");
  const verifierDigest = await verifierVersion(bundle);
  for (const trial of store.trials(id)) {
    const attempt = store.attempts(trial.id).at(-1);
    if (!attempt || attempt.status === "running" || attempt.cleanup !== "done") continue;
    const path = join(attempt.directory, "artifacts.json");
    if (!existsSync(path)) continue;
    const evidence = new Evidence(join(attempt.directory, "evidence"), attempt.id);
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      files_ref: string;
      digest: string;
      complete?: boolean;
    };
    // Old manifests came from the strict collector. Explicitly incomplete new
    // manifests cannot turn a collection failure into a candidate failure.
    if (manifest.complete === false) continue;
    const files = JSON.parse(evidence.read(manifest.files_ref)) as Record<string, string>;
    if (artifactDigest(files) !== manifest.digest)
      throw new Error("Artifact manifest digest mismatch");
    const item = frozen.cases.find((c) => c.id === trial.case_id)!;
    const specDigest = digest(JSON.stringify({ item, verifier: verifierDigest, environment }));
    const existing = store
      .evaluations(attempt.id)
      .find(
        (e) =>
          e.spec_digest === specDigest &&
          e.evidence_digest === manifest.digest &&
          JSON.parse(e.result_json).status !== "evaluation_error",
      );
    if (existing) continue;
    store.markPending(attempt.id);
    const evaluation = await sandbox.verify({
      item,
      files,
      directory: attempt.directory,
      bundle,
      id: attempt.id,
    });
    store.markClean(attempt.id);
    evidence.emit("evaluation.rescored", {
      evaluation,
      verifierDigest,
      specDigest,
      environment,
    });
    store.score(attempt.id, manifest.digest, specDigest, evaluation);
  }
}
