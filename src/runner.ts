import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCase, repairScript } from "./cases";
import { type Case, type DriverRequest, type ExperimentSpec, harnessVersion } from "./contracts";
import { digest, Evidence } from "./evidence";
import { systemPrompt } from "./harness/runtime";
import { artifactDigest, ContainerCleanupError, Docker } from "./sandbox/docker";
import type { Store, TrialRow } from "./store";

export type FrozenExperiment = {
  spec: ExperimentSpec;
  cases: Case[];
  image: string;
  harnessVersion: string;
  bunVersion: string;
  systemPrompt: string;
  driverDigest: string;
  verifierDigest: string;
  policy: { retry: "none"; order: "seeded-case-blocks"; concurrency: 1; context: "full-history/1" };
};
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
  docker = new Docker(),
): Promise<string> {
  await docker.doctor();
  const active = store.active();
  if (active.length)
    throw new Error(
      "Unreconciled attempts exist. Run detroit recover before creating another experiment.",
    );
  const image = await docker.resolveImage(spec.image);
  const driver = join(project, "dist/reference.js"),
    verifier = join(project, "dist/verifier.js");
  const items = spec.cases.map(getCase);
  const apiKey = process.env.OPENAI_API_KEY;
  if (spec.variants.some((v) => v.provider === "openai") && !apiKey)
    throw new Error("OPENAI_API_KEY is required");
  const frozen: FrozenExperiment = {
    spec,
    cases: items,
    image,
    harnessVersion,
    bunVersion: Bun.version,
    systemPrompt,
    driverDigest: digest(await readFile(driver)),
    verifierDigest: digest(await readFile(verifier)),
    policy: {
      retry: "none",
      order: "seeded-case-blocks",
      concurrency: 1,
      context: "full-history/1",
    },
  };
  const id = randomUUID();
  const trials = schedule(id, spec);
  store.freeze(id, spec, frozen, trials);
  console.log(`Experiment ${id} · ${trials.length} trials · image ${image}`);
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
      let outcome: Awaited<ReturnType<Docker["run"]>> | undefined;
      try {
        outcome = await docker.run({
          item,
          request,
          image,
          directory,
          bundle: driver,
          signal: combined,
          apiKey: variant.provider === "openai" ? apiKey : undefined,
        });
        cleanup = outcome.cleanup;
        const evidence = new Evidence(join(directory, "evidence"), attemptId);
        evidence.emit("experiment.config", {
          requested: variant,
          image,
          driverDigest: frozen.driverDigest,
          synthetic: variant.provider !== "openai",
        });
        if (outcome.files) {
          const manifest = {
            files_ref: evidence.put(outcome.files),
            digest: artifactDigest(outcome.files),
          };
          await writeFile(join(directory, "artifacts.json"), JSON.stringify(manifest));
          evidence.emit("artifacts.manifest", manifest);
          if (cleanup && !combined.aborted) {
            const evaluation = await docker.verify({
              item,
              files: outcome.files,
              image,
              directory,
              bundle: verifier,
              id: attemptId,
            });
            evidence.emit("evaluation.completed", {
              evaluation,
              verifierDigest: frozen.verifierDigest,
            });
            store.score(
              attemptId,
              manifest.digest,
              digest(JSON.stringify({ item, verifier: frozen.verifierDigest, image })),
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
        if (error instanceof ContainerCleanupError) cleanup = false;
        store.finish(
          attemptId,
          combined.aborted ? "cancelled" : (outcome?.status ?? "error"),
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

export async function recover(store: Store, docker = new Docker()) {
  await docker.doctor();
  for (const attempt of store.active()) {
    const agentClean = await docker.remove(`detroit-a-${attempt.id}`);
    const verifierClean = await docker.remove(`detroit-v-${attempt.id}`);
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

export async function rescore(id: string, store: Store, project: string, docker = new Docker()) {
  await docker.doctor();
  const frozen = JSON.parse(store.experiment(id).spec_json) as FrozenExperiment;
  const bundle = join(project, "dist/verifier.js");
  const verifierDigest = digest(await readFile(bundle));
  for (const trial of store.trials(id)) {
    const attempt = store.attempts(trial.id).at(-1);
    if (!attempt || attempt.status === "running" || attempt.cleanup !== "done") continue;
    const path = join(attempt.directory, "artifacts.json");
    if (!existsSync(path)) continue;
    const evidence = new Evidence(join(attempt.directory, "evidence"), attempt.id);
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      files_ref: string;
      digest: string;
    };
    const files = JSON.parse(evidence.read(manifest.files_ref)) as Record<string, string>;
    if (artifactDigest(files) !== manifest.digest)
      throw new Error("Artifact manifest digest mismatch");
    const item = frozen.cases.find((c) => c.id === trial.case_id)!;
    const specDigest = digest(
      JSON.stringify({ item, verifier: verifierDigest, image: frozen.image }),
    );
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
    const evaluation = await docker.verify({
      item,
      files,
      image: frozen.image,
      directory: attempt.directory,
      bundle,
      id: attempt.id,
    });
    store.markClean(attempt.id);
    evidence.emit("evaluation.rescored", { evaluation, verifierDigest, specDigest });
    store.score(attempt.id, manifest.digest, specDigest, evaluation);
  }
}
