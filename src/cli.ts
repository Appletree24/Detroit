import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CaseImports } from "./case-imports";
import { experimentSchema } from "./contracts";
import { collectionInputSchema } from "./import-contract";
import { serveImports } from "./import-server";
import { writeReport } from "./report";
import { recover, rescore, runExperiment } from "./runner";
import { Bubblewrap, type SandboxEnvironment } from "./sandbox/bubblewrap";
import { acquireLock, Store } from "./store";

const project = resolve(import.meta.dir, "..");
const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    data: { type: "string", default: join(project, ".detroit") },
    out: { type: "string", default: join(project, ".detroit/report.html") },
    port: { type: "string", default: "8787" },
    approve: { type: "string" },
    collection: { type: "string" },
    case: { type: "string" },
    "source-group": { type: "string" },
    revision: { type: "string" },
    "expected-revision": { type: "string" },
    weight: { type: "string", default: "1" },
    "confirm-exposure": { type: "boolean", default: false },
    reason: { type: "string" },
  },
});
const [command, arg] = positionals;
const root = resolve(values.data);
const help = `Detroit M1
  bun run detroit doctor
  bun run detroit run experiments/smoke.json
  bun run detroit status <experiment-id>
  bun run detroit cancel <experiment-id>
  bun run detroit recover
  bun run detroit score <experiment-id>
  bun run detroit report <experiment-id> --out report.html
  bun run detroit serve --port 8787
  bun run detroit case preview <manifest.json>
  bun run detroit case import <manifest.json> --approve <approval-digest> [--collection <id>]
  bun run detroit case list
  bun run detroit case show <case-id> [--revision <n>]
  bun run detroit collection create <collection.json>
  bun run detroit collection list
  bun run detroit collection show <collection-id>
  bun run detroit collection add <collection-id> <case-id> [--revision <n>] [--weight <n>]
Options: --data <directory>
run always uses Bubblewrap on Linux. Docker is not required.
Ctrl-C requests cancellation and sandbox cleanup.
Import saves drafts only; never runs project commands or models.
Updating a draft: case import ... --case <id> --expected-revision <n>.
Use --source-group <id> on preview/import to save another linked case.
Validation exposure: --confirm-exposure --reason <explanation>.
serve holds the writer lock; stop it before using case/collection CLI.
`;

async function manageImports() {
  const subcommand = arg;
  const target = positionals[2];
  if (!subcommand) throw new Error(`${command} requires a subcommand; see help`);
  const release = acquireLock(root);
  let store: Store | undefined;
  try {
    store = new Store(root);
    const imports = new CaseImports(store);
    let result: unknown;
    if (command === "case") {
      if (subcommand === "list") {
        result = imports.list();
      } else if (subcommand === "show") {
        if (!target) throw new Error("case show requires case-id");
        result = imports.get(
          target,
          values.revision === undefined ? undefined : Number(values.revision),
        );
      } else if (subcommand === "preview" || subcommand === "import") {
        if (!target) throw new Error(`case ${subcommand} requires manifest.json`);
        const sourceGroupId =
          values["source-group"] ??
          (values.case ? imports.get(values.case).sourceGroupId : undefined);
        const payload = await imports.prepareLocal(resolve(target), sourceGroupId);
        if (subcommand === "preview") {
          result = imports.preview(payload);
        } else {
          if (!values.approve)
            throw new Error(
              "case import requires --approve digest from case preview; changed files require a new preview",
            );
          result = imports.confirm(payload, {
            approved: true,
            approvalDigest: values.approve,
            collectionId: values.collection,
            caseId: values.case,
            expectedRevision:
              values["expected-revision"] === undefined
                ? undefined
                : Number(values["expected-revision"]),
            weight: Number(values.weight),
            confirmExposure: values["confirm-exposure"],
            exposureReason: values.reason,
          });
        }
      } else {
        throw new Error(`unknown case subcommand ${subcommand}`);
      }
    } else if (subcommand === "list") {
      result = imports.collections();
    } else if (subcommand === "create") {
      if (!target) throw new Error("collection create requires collection.json");
      result = imports.createCollection(
        collectionInputSchema.parse(await Bun.file(resolve(target)).json()),
      );
    } else if (subcommand === "show") {
      result = imports.collections().find((collection) => collection.id === target);
      if (!result) throw new Error("unknown collection-id");
    } else if (subcommand === "add") {
      const caseId = positionals[3];
      if (!target || !caseId) throw new Error("collection add requires collection-id case-id");
      result = imports.addToCollection(caseId, target, {
        revision: values.revision === undefined ? undefined : Number(values.revision),
        weight: Number(values.weight),
        confirmExposure: values["confirm-exposure"],
        exposureReason: values.reason,
      });
    } else {
      throw new Error(`unknown collection subcommand ${subcommand}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store?.close();
    release();
  }
}

async function main() {
  if (!command || command === "help") {
    console.log(help);
    return;
  }
  if (command === "serve") {
    await serveImports(root, Number(values.port));
    return;
  }
  if (command === "case" || command === "collection") {
    await manageImports();
    return;
  }
  const sandbox = new Bubblewrap();
  if (command === "doctor") {
    const driverReady =
      existsSync(join(project, "dist/reference.js")) &&
      existsSync(join(project, "dist/verifier.js"));
    const omp = Bun.which("omp");
    let environment: SandboxEnvironment | null = null;
    let failure: string | null = null;
    try {
      environment = await sandbox.doctor();
    } catch (error) {
      failure = String(error);
    }
    console.log(
      JSON.stringify(
        {
          bun: Bun.version,
          sandbox: environment ?? { kind: "bubblewrap", error: failure },
          drivers: driverReady ? "built" : "run bun run build",
          externalHarness: {
            ompBinary: omp ? "available" : "unavailable (install from https://omp.sh)",
            ompDriver: existsSync(join(project, "dist/omp.js")) ? "built" : "run bun run build",
          },
          openaiCredential: process.env.OPENAI_API_KEY
            ? "present"
            : "absent (scripted runs need none)",
          capabilities: {
            provider: ["openai", "scripted", "external/omp"],
            context: ["full-history/1"],
            streaming: false,
            steering: false,
            resume: false,
          },
          readyForScriptedRun: Boolean(environment && driverReady),
          isolation: {
            network: "none by default; explicit host sharing for model calls",
            hostTools: "read-only /usr; host home is not mounted",
            aggregateResourceLimits: "not enforced; cgroup integration is not implemented",
          },
        },
        null,
        2,
      ),
    );
    if (!environment || !driverReady) process.exitCode = 1;
    return;
  }
  if (!["run", "status", "cancel", "recover", "score", "report"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (command !== "recover" && !arg) throw new Error(`${command} requires an argument`);
  const mutating = ["run", "recover", "score"].includes(command);
  const release = mutating ? acquireLock(root) : () => {};
  let store: Store | undefined;
  try {
    store = new Store(root);
    if (command === "run") {
      const spec = experimentSchema.parse(await Bun.file(resolve(arg!)).json());
      const controller = new AbortController();
      const cancel = () => {
        console.error("Cancellation requested; stopping sandbox and collecting artifacts…");
        controller.abort();
      };
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
      try {
        const id = await runExperiment(spec, store, project, controller.signal, sandbox);
        await writeReport(id, store, resolve(values.out));
        console.log(`Report: ${resolve(values.out)}`);
        if (controller.signal.aborted) process.exitCode = 130;
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    } else if (command === "recover") {
      await recover(store, sandbox);
      console.log("Interrupted attempts reconciled. No attempts were rerun.");
    } else if (command === "score") {
      await rescore(arg!, store, project, sandbox);
      console.log("Scoring complete; existing identical evaluations retained.");
    } else if (command === "report") {
      await writeReport(arg!, store, resolve(values.out));
      console.log(resolve(values.out));
    } else if (command === "cancel") {
      store.experiment(arg!);
      writeFileSync(join(root, `${arg}.cancel`), new Date().toISOString(), { mode: 0o600 });
      console.log("Cancellation request recorded. Use status to confirm termination.");
    } else {
      const experiment = store.experiment(arg!);
      const db = store;
      console.log(
        JSON.stringify(
          {
            id: experiment.id,
            name: experiment.name,
            trials: db.trials(arg!).map((t) => ({
              ...t,
              attempts: db.attempts(t.id).map((a) => ({ ...a, evaluations: db.evaluations(a.id) })),
            })),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    store?.close();
    release();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
