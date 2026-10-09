import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { experimentSchema } from "./contracts";
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
Options: --data <directory>
run always uses Bubblewrap on Linux. Docker is not required.
Ctrl-C requests cancellation and sandbox cleanup.
`;

async function main() {
  if (!command || command === "help") {
    console.log(help);
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
