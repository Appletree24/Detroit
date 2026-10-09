import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cases } from "../src/cases";
import { experimentSchema, variantSchema } from "../src/contracts";
import { Evidence } from "../src/evidence";
import { writeReport } from "../src/report";
import { recover, rescore, runExperiment } from "../src/runner";
import { Bubblewrap } from "../src/sandbox/bubblewrap";
import { writeFiles } from "../src/sandbox/files";
import { launchSandbox, removeSandbox } from "../src/sandbox/lifecycle";
import { Store } from "../src/store";

const available = process.platform === "linux" && Boolean(Bun.which("bwrap"));
const integration = available ? test : test.skip;
if (!available) console.warn("Bubblewrap integration skipped: Linux and bwrap are required.");
let root = "";
const sandbox = new Bubblewrap();
beforeAll(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), "detroit-bwrap-"));
  const build = await Bun.build({
    entrypoints: ["src/drivers/reference.ts", "src/drivers/verifier.ts"],
    outdir: join(root, "dist"),
    target: "bun",
  });
  if (!build.success) throw new AggregateError(build.logs);
  await sandbox.doctor(); // Installed but unusable bwrap is a failure, not a skip.
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function waitFor(path: string) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path) && (await readFile(path, "utf8")).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

integration(
  "real Bubblewrap: full 10-trial batch, report and idempotent rescore",
  async () => {
    const store = new Store(join(root, "batch"));
    try {
      const spec = experimentSchema.parse(await Bun.file("experiments/smoke.json").json());
      const id = await runExperiment(spec, store, root, new AbortController().signal, sandbox);
      const attempts = store.trials(id).map((t) => store.attempts(t.id)[0]!);
      expect(attempts).toHaveLength(10);
      for (const trial of store.trials(id)) {
        const attempt = store.attempts(trial.id)[0]!;
        expect(attempt.status).toBe("finished");
        expect(attempt.cleanup).toBe("done");
        const score = JSON.parse(store.evaluations(attempt.id)[0]!.result_json);
        expect(score.status).toBe(trial.variant_id === "scripted-repair" ? "pass" : "fail");
        const trace = new Evidence(join(attempt.directory, "evidence"), attempt.id);
        expect(trace.events().some((e) => e.event_type === "model.response")).toBe(true);
      }
      await rescore(id, store, root, sandbox);
      expect(store.trials(id).flatMap((t) => store.attempts(t.id))).toHaveLength(10);
      expect(attempts.map((a) => store.evaluations(a.id).length)).toEqual(Array(10).fill(1));
      expect(store.active()).toHaveLength(0);
      await writeReport(id, store, join(root, "smoke.html"));
      const html = await readFile(join(root, "smoke.html"), "utf8");
      expect(html).toContain("5/5");
      expect(html).toContain("0/5");
      expect(html).toContain("bubblewrap");
    } finally {
      store.close();
    }
  },
  60_000,
);

integration(
  "real Bubblewrap: selective mounts, cleared environment, network none and host",
  async () => {
    const directory = join(root, "visibility");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("host") });
    process.env.DETROIT_HOST_SECRET = "must-stay-outside";
    try {
      await writeFiles(directory, {
        "workspace/public.txt": "public",
        "probe.js": `
import {existsSync, readFileSync} from 'node:fs';
let reached = false;
try { reached = (await (await fetch("http://127.0.0.1:${server.port}", {signal:AbortSignal.timeout(300)})).text()) === "host"; } catch {}
console.log(JSON.stringify({
  uid:process.getuid(), secret:process.env.DETROIT_HOST_SECRET ?? null,
  hostProject:existsSync(${JSON.stringify(resolve("."))}),
  hostHome:existsSync(${JSON.stringify(process.env.HOME)}),
  tests:existsSync("/control/case.json"), reached,
  noNewPrivs:/NoNewPrivs:\\s+1/.test(readFileSync("/proc/self/status","utf8"))
}));`,
      });
      for (const network of ["none", "host"] as const) {
        const output = await launchSandbox(
          sandbox.command({
            workspace: join(directory, "workspace"),
            bundle: join(directory, "probe.js"),
            network,
          }),
          directory,
          "agent",
        );
        expect(output.code).toBe(0);
        expect(JSON.parse(output.stdout)).toEqual({
          uid: 1000,
          secret: null,
          hostProject: false,
          hostHome: false,
          tests: false,
          reached: network === "host",
          noNewPrivs: true,
        });
      }
    } finally {
      delete process.env.DETROIT_HOST_SECRET;
      server.stop(true);
    }
  },
);

integration(
  "real Bubblewrap: verifier cannot write artifacts or read hidden expected values",
  async () => {
    const item = cases[0]!;
    const directory = join(root, "protected");
    const options = { item, directory, bundle: join(root, "dist/verifier.js"), id: randomUUID() };
    const score = await sandbox.verify({
      ...options,
      files: {
        "index.mjs": `
import {existsSync,writeFileSync} from "node:fs";
if(existsSync("/control/case.json") || existsSync("/evidence")) throw Error("private mount");
let denied=false;
try { writeFileSync("/workspace/tampered.txt", "bad"); } catch { denied=true; }
if(!denied) throw Error("workspace writable");
${item.solution}`,
      },
    });
    expect(score.status).toBe("pass");
    expect(existsSync(join(directory, "verification", options.id, "workspace/tampered.txt"))).toBe(
      false,
    );
    expect(
      (
        await sandbox.verify({
          ...options,
          id: randomUUID(),
          files: {
            "index.mjs": `import {readFileSync} from "node:fs";readFileSync("/control/case.json");${item.solution}`,
          },
        })
      ).status,
    ).toBe("fail");
  },
);

// A detached process with redirected stdio escapes ordinary process-group cleanup.
// Its heartbeat must stop before collection, including when the coordinator dies.
const background = `setsid sh -c 'while :; do echo x >> /workspace/heartbeat; sleep 0.03; done' </dev/null >/dev/null 2>&1 &`;
integration(
  "real Bubblewrap: cancellation reaps a detached background process",
  async () => {
    const directory = join(root, "cancel");
    const controller = new AbortController();
    const pending = sandbox.run({
      item: cases[0]!,
      directory,
      network: "none",
      bundle: join(root, "dist/reference.js"),
      signal: controller.signal,
      request: {
        protocol_version: 1,
        attempt_id: randomUUID(),
        instruction: "cancel fixture",
        variant: variantSchema.parse({ id: "cancel", provider: "scripted-repair" }),
        script: [
          {
            content: "",
            toolCalls: [
              {
                id: "background",
                name: "shell",
                arguments: JSON.stringify({ command: `${background} sleep 30`, timeout_ms: 30000 }),
              },
            ],
          },
        ],
      },
    });
    const heartbeat = join(directory, "input/workspace/heartbeat");
    try {
      await waitFor(heartbeat);
    } finally {
      controller.abort();
    }
    const output = await pending;
    expect(output.status).toBe("cancelled");
    expect(output.cleanup).toBe(true);
    const final = await readFile(heartbeat, "utf8");
    await settle();
    expect(await readFile(heartbeat, "utf8")).toBe(final);
    expect(await removeSandbox(directory, "agent")).toBe(true);
  },
  10_000,
);

integration(
  "real Bubblewrap: coordinator SIGKILL, PID-safe recovery and no rerun",
  async () => {
    const directory = join(root, "crash");
    const workspace = join(directory, "workspace");
    await writeFiles(directory, {
      "workspace/.fixture": "",
      "program.js": `Bun.spawn(["sh","-c",${JSON.stringify(`${background} sleep 30`)}],{stdout:"inherit",stderr:"inherit"});await new Promise(()=>{});`,
      "coordinator.ts": `
import {Bubblewrap} from ${JSON.stringify(resolve("src/sandbox/bubblewrap.ts"))};
import {launchSandbox} from ${JSON.stringify(resolve("src/sandbox/lifecycle.ts"))};
await launchSandbox(new Bubblewrap().command({
 workspace:${JSON.stringify(workspace)},bundle:${JSON.stringify(join(directory, "program.js"))},network:"none"
}),${JSON.stringify(directory)},"agent",{timeoutMs:30000});`,
    });
    const child = spawn(process.execPath, [join(directory, "coordinator.ts")], { stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    const heartbeat = join(workspace, "heartbeat");
    try {
      await waitFor(heartbeat);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    // Exercise recovery through the database path, not only a standalone PID kill.
    const store = new Store(join(root, "crash-store"));
    try {
      const spec = experimentSchema.parse({
        name: "crash",
        cases: ["clamp"],
        variants: [{ id: "noop", provider: "scripted-noop" }],
      });
      store.freeze("crash", spec, { environment: { kind: "bubblewrap" } }, [
        {
          id: "trial",
          experiment_id: "crash",
          case_id: "clamp",
          variant_id: "noop",
          repeat_index: 0,
          ordinal: 0,
        },
      ]);
      store.start("crashed", "trial", directory);
      await recover(store, sandbox);
      expect(store.attempts("trial")[0]!.status).toBe("interrupted");
      expect(store.attempts("trial")).toHaveLength(1);
      expect(store.active()).toHaveLength(0);
      const final = await readFile(heartbeat, "utf8");
      await settle();
      expect(await readFile(heartbeat, "utf8")).toBe(final);
    } finally {
      store.close();
    }
  },
  10_000,
);

integration("recovery refuses incomplete launches and never kills a reused PID", async () => {
  const directory = join(root, "stale");
  await writeFiles(directory, {
    "agent.process.json": JSON.stringify({ kind: "bubblewrap", state: "starting" }),
  });
  expect(await removeSandbox(directory, "agent")).toBe(false);
  await writeFile(
    join(directory, "agent.process.json"),
    JSON.stringify({ kind: "bubblewrap", state: "running", identity: {} }),
  );
  expect(await removeSandbox(directory, "agent")).toBe(false);
  await writeFile(
    join(directory, "agent.process.json"),
    JSON.stringify({
      kind: "bubblewrap",
      state: "running",
      identity: {
        pid: process.pid,
        start: "0",
        boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      },
    }),
  );
  expect(await removeSandbox(directory, "agent")).toBe(true);
});

integration("real Bubblewrap: evidence symlinks cannot redirect host collection", async () => {
  const directory = join(root, "trace-link");
  const sentinel = join(root, "private-sentinel");
  await writeFile(sentinel, "unchanged");
  await writeFiles(directory, {
    "driver.js": `import {symlinkSync} from "node:fs";symlinkSync(${JSON.stringify(sentinel)},"/evidence/events.jsonl");`,
  });
  const output = await sandbox.run({
    item: cases[0]!,
    directory,
    network: "none",
    bundle: join(directory, "driver.js"),
    signal: new AbortController().signal,
    request: {
      protocol_version: 1,
      attempt_id: randomUUID(),
      instruction: "trace fixture",
      variant: variantSchema.parse({ id: "trace", provider: "scripted-noop" }),
    },
  });
  expect(output.status).toBe("error");
  expect(output.collectionError).toContain("Symlinks");
  expect(output.collection?.trace.complete).toBe(false);
  expect(output.error ?? "").not.toContain("Symlinks");
  expect(output.cleanup).toBe(true);
  expect(await readFile(sentinel, "utf8")).toBe("unchanged");
});

integration(
  "real Bubblewrap: wall deadline and output limit stop broken drivers",
  async () => {
    for (const mode of ["timeout", "overflow"]) {
      const directory = join(root, mode);
      await writeFiles(directory, {
        "driver.js":
          mode === "timeout"
            ? "setInterval(()=>{},1000)"
            : "while(true)process.stdout.write('x'.repeat(65536))",
      });
      const output = await sandbox.run({
        item: cases[0]!,
        directory,
        network: "none",
        bundle: join(directory, "driver.js"),
        signal: new AbortController().signal,
        request: {
          protocol_version: 1,
          attempt_id: randomUUID(),
          instruction: mode,
          variant: variantSchema.parse({
            id: mode,
            provider: "scripted-noop",
            budgets: { deadlineMs: 100 },
          }),
        },
      });
      expect(output.status).toBe(mode === "timeout" ? "timed_out" : "error");
      expect(output.cleanup).toBe(true);
    }
  },
  10_000,
);

integration(
  "real Bubblewrap: collection errors preserve finished execution and safe partial artifacts",
  async () => {
    const directory = join(root, "partial-finished");
    await writeFiles(directory, {
      "driver.js": `
import {writeFileSync,symlinkSync} from "node:fs";
const request=JSON.parse(await Bun.stdin.text());
writeFileSync("/workspace/kept.txt","kept");
writeFileSync("/workspace/oversized.txt","x".repeat(1024*1024+1));
symlinkSync("/etc/passwd","/workspace/link");
const configuration={requested:request.variant,applied:{},observed:{},unknown:[],unsupported:[],provenance:{}};
console.log(JSON.stringify({type:"ready",protocol_version:1,harness_version:"collection-fixture"}));
console.log(JSON.stringify({type:"accepted",attempt_id:request.attempt_id,configuration}));
console.log(JSON.stringify({type:"done",result:{stopReason:"final_response",modelCalls:1,toolCalls:0,knownTokens:7,usageComplete:false,costUSD:null,elapsedMs:1}}));`,
    });
    const output = await sandbox.run({
      item: cases[0]!,
      directory,
      network: "none",
      bundle: join(directory, "driver.js"),
      signal: new AbortController().signal,
      request: {
        protocol_version: 1,
        attempt_id: randomUUID(),
        instruction: "partial fixture",
        variant: variantSchema.parse({ id: "partial", provider: "scripted-noop" }),
      },
    });
    expect(output.status).toBe("finished");
    expect(output.error).toBeNull();
    expect(output.result?.knownTokens).toBe(7);
    expect(output.files?.["kept.txt"]).toBe("kept");
    expect(output.files?.["oversized.txt"]).toBeUndefined();
    expect(output.files?.link).toBeUndefined();
    expect(output.collection?.workspace.complete).toBe(false);
    expect(output.collection?.workspace.truncated).toBe(true);
    expect(output.collectionError).toContain("oversized.txt");
    expect(output.collectionError).toContain("Symlinks");
    expect(output.cleanup).toBe(true);
  },
);

integration(
  "real Bubblewrap: malformed evidence cannot relabel a deadline or discard safe files",
  async () => {
    const directory = join(root, "partial-deadline");
    await writeFiles(directory, {
      // Real subprocess deadlines and namespace teardown cannot use fake JS timers.
      "driver.js": `import {writeFileSync} from "node:fs";writeFileSync("/workspace/kept.txt","kept");writeFileSync("/evidence/events.jsonl","{");setInterval(()=>{},1000);`,
    });
    const attemptId = randomUUID();
    const output = await sandbox.run({
      item: cases[0]!,
      directory,
      network: "none",
      bundle: join(directory, "driver.js"),
      signal: new AbortController().signal,
      request: {
        protocol_version: 1,
        attempt_id: attemptId,
        instruction: "deadline fixture",
        variant: variantSchema.parse({
          id: "deadline",
          provider: "scripted-noop",
          budgets: { deadlineMs: 100 },
        }),
      },
    });
    expect(output.status).toBe("timed_out");
    expect(output.files?.["kept.txt"]).toBe("kept");
    expect(output.collection?.trace.complete).toBe(false);
    expect(output.collectionError).toContain("journal");
    expect(output.cleanup).toBe(true);
    const evidence = new Evidence(join(directory, "evidence"), attemptId);
    expect(evidence.events().some((event) => event.event_type === "runner.collected")).toBe(true);
    expect(await readFile(join(directory, "unvalidated-events.jsonl"), "utf8")).toBe("{");
  },
  10_000,
);
