import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentSchema } from "../src/contracts";
import { type OmpFrame, OmpFrameDecoder, ompFrames } from "../src/drivers/omp-rpc";
import { Evidence } from "../src/evidence";

const projectRoot = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
type Scenario =
  | "ok"
  | "fail"
  | "local"
  | "background"
  | "provider-error"
  | "aborted"
  | "chunks"
  | "overflow"
  | "closed"
  | "bad-ready"
  | "unknown-model"
  | "timeout";
// Synthetic transport fixture only: no model provider or network call.
const fakeOmp = (scenario: Scenario, key: boolean) => `
const scenario=${JSON.stringify(scenario)};
const w=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
const reply=(m,data={})=>w({id:m.id,type:"response",command:m.type,success:true,data});
if(${key} && (process.argv.includes("key-for-test-only") || process.argv.includes("--api-key") || process.env.OPENAI_API_KEY!=="key-for-test-only")) throw new Error("credential transport violated");
w({type:"ready",protocolVersion:1,supportedProtocolVersions:scenario==="bad-ready"?[1]:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});
let buf=""; const dec=new TextDecoder();
for await (const bytes of Bun.stdin.stream()) {
 buf+=dec.decode(bytes,{stream:true});
 for (;;) {
  const nl=buf.indexOf("\\n"); if(nl<0)break;
  const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line)continue;
  const m=JSON.parse(line);
  if(m.type==="negotiate_protocol" || m.type==="set_event_filter")reply(m,{protocolVersion:2});
  else if(m.type==="get_state")reply(m,scenario==="unknown-model"?{}:{model:{provider:"openai",id:"test-observed",baseUrl:"secret-endpoint",headers:{Authorization:"secret-header"}}});
  else if(m.type==="prompt") {
   if(scenario==="fail") {w({id:m.id,type:"response",command:"prompt",success:false,error:"secret-provider-diagnostic"});continue;}
   if(scenario==="local") {reply(m,{agentInvoked:false});continue;}
   reply(m,{agentInvoked:true});
   if(scenario==="closed")process.exit(0);
   if(scenario==="timeout")continue;
   if(scenario==="overflow") {process.stdout.write(JSON.stringify({type:"message_end",text:"x".repeat(1048576)})+"\\n");continue;}
   w({type:"agent_start"});
   w({type:"message_start",messageId:"m1",message:{role:"assistant",content:"secret-message",provider:"openai",model:"test-observed"}});
   w({type:"tool_execution_start",toolCallId:"t1",toolName:"read",args:{credential:"secret-argument"}});
   w({type:"tool_execution_start",toolCallId:"t1",toolName:"read"});
   w({type:"message_end",messageId:"m1",message:{role:"assistant",content:[{type:"text",text:"secret-message"}],provider:"openai",model:"test-observed",usage:{totalTokens:17,cost:{total:0.01}}}});
   w({type:"agent_end",messages:[],yielded:true,isTerminal:true});
   w({type:"prompt_result",id:"unrelated",agentInvoked:true,status:"error",sessionSettled:true});
   w({type:"prompt_result",id:m.id,agentInvoked:true,status:scenario==="provider-error"?"error":scenario==="aborted"?"aborted":"completed",sessionSettled:scenario!=="background",error:{message:"secret-provider-diagnostic"}});
   if(scenario==="background") {
    w({type:"agent_start"});
    w({type:"message_end",messageId:"m2",message:{role:"assistant",provider:"openai",model:"test-observed",usage:{totalTokens:5,cost:{total:0.02}}}});
    w({type:"agent_end",messages:[],yielded:true,isTerminal:true});
    w({type:"session_settled"});
   }
  } else if(m.type==="get_last_assistant_text") {
   if(scenario==="chunks") {
    const bytes=Buffer.from(JSON.stringify({id:m.id,type:"response",command:m.type,success:true,data:{text:"x".repeat(1100000)}}));
    const count=Math.ceil(bytes.length/262144);
    for(let index=0;index<count;index++)w({type:"rpc_chunk",chunkId:"large",index,count,byteLength:bytes.length,data:bytes.subarray(index*262144,(index+1)*262144).toString("base64")});
   } else reply(m,{text:"done"});
  }
 }
}
`;
async function runDriver(
  scenario: Scenario,
  options: { key?: boolean; unqualified?: boolean; model?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "detroit-omp-"));
  dirs.push(dir);
  const workspace = join(dir, "workspace"),
    evidence = join(dir, "evidence"),
    fakePath = join(dir, "fake-omp.ts");
  await mkdir(workspace);
  await writeFile(fakePath, fakeOmp(scenario, options.key ?? false));
  const request = {
    protocol_version: 1,
    attempt_id: "attempt-1",
    instruction: "test transport only",
    api_key: options.key ? "key-for-test-only" : undefined,
    variant: {
      id: "omp",
      driver: "omp",
      provider: "external",
      model: options.model ?? (options.unqualified ? "test" : "openai/test"),
      budgets: { deadlineMs: scenario === "timeout" ? 200 : 5000 },
    },
  };
  const proc = Bun.spawn([process.execPath, join(projectRoot, "src/drivers/omp.ts")], {
    cwd: projectRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      DETROIT_OMP_SPAWN: JSON.stringify([process.execPath, fakePath]),
      DETROIT_OMP_WORKSPACE: workspace,
      DETROIT_OMP_EVIDENCE: evidence,
    },
  });
  proc.stdin.write(JSON.stringify(request));
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const journal = new Evidence(evidence, "attempt-1", "omp");
  const events = journal.events();
  return {
    lines,
    stderr,
    code,
    events,
    payloads: events.map((e) => journal.read(e.raw_ref)).join("\n"),
    journal: await readFile(join(evidence, "events.jsonl"), "utf8"),
  };
}

test("OMP correlates prompt_result, observes real identities and never claims requested config effective", async () => {
  const { lines, events, payloads, code } = await runDriver("ok");
  expect(code).toBe(0);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatchObject({ type: "ready", protocol_version: 1 });
  expect(lines[1].configuration).toMatchObject({
    requested: { model: "openai/test" },
    applied: { model: "openai/test" },
    observed: { model: { provider: "openai", id: "test-observed" } },
  });
  expect(lines[1].configuration.unknown).toContain("temperature");
  expect(lines[1].configuration.unknown).not.toContain("model");
  expect(lines[1].effective_config).toBeUndefined();
  expect(lines[2].result).toMatchObject({
    stopReason: "final_response",
    modelCalls: 1,
    toolCalls: 1,
    knownTokens: 17,
    usageComplete: false,
    costUSD: null,
    countersComplete: false,
    finalOutput: "done",
    evidenceComplete: true,
  });
  expect(events.every((e) => e.source_id === "omp")).toBe(true);
  expect(payloads).not.toContain("secret-");
  expect(payloads).toContain("omp-shim");
});
test("OMP waits for background continuation to settle before reading final text", async () => {
  const { lines } = await runDriver("background");
  expect(lines[2].result).toMatchObject({
    stopReason: "final_response",
    modelCalls: 2,
    knownTokens: 22,
    finalOutput: "done",
  });
});
test("OMP local-only prompt finishes without agent_end", async () => {
  const { lines } = await runDriver("local");
  expect(lines[2].result).toMatchObject({
    stopReason: "final_response",
    modelCalls: 0,
    knownTokens: 0,
    usageComplete: false,
  });
});
for (const scenario of ["fail", "provider-error", "closed", "overflow", "bad-ready"] as const)
  test(`OMP ${scenario} fails without false final success`, async () => {
    const { lines, payloads } = await runDriver(scenario);
    expect(lines.map((f) => f.type)).toEqual(["ready", "accepted", "done"]);
    expect(lines[2].result.stopReason).toBe("error");
    expect(payloads).not.toContain("secret-provider-diagnostic");
  });
test("OMP provider abort stays cancellation rather than success", async () => {
  const { lines } = await runDriver("aborted");
  expect(lines[2].result.stopReason).toBe("cancelled");
});
// Cross-process integration: the child owns its real deadline clock, so parent fake timers cannot drive it.
test("OMP supervisor deadline bounds a prompt lacking completion", async () => {
  const { lines } = await runDriver("timeout");
  expect(lines[2].result.stopReason).toBe("deadline");
});
test("OMP absence of resolved model remains unknown", async () => {
  const { lines } = await runDriver("unknown-model");
  expect(lines[1].configuration.unknown).toContain("model");
  expect(lines[1].configuration.observed.model).toBeUndefined();
});
test("documented OMP experiment routes its API key only through the selected provider environment", async () => {
  const spec = experimentSchema.parse(
    await Bun.file(join(projectRoot, "experiments/omp.json")).json(),
  );
  const { lines, payloads } = await runDriver("ok", { key: true, model: spec.variants[0]!.model });
  expect(lines[2].result.stopReason).toBe("final_response");
  expect(payloads).not.toContain("key-for-test-only");
});
test("OMP unqualified API key fails closed without exposing secret", async () => {
  const { lines, payloads } = await runDriver("ok", { key: true, unqualified: true });
  expect(lines.map((f) => f.type)).toEqual(["ready", "accepted", "done"]);
  expect(lines[2].result.stopReason).toBe("error");
  expect(payloads).not.toContain("key-for-test-only");
});
test("OMP losslessly decodes RPC chunks then marks its own bounded output truncation", async () => {
  const { lines } = await runDriver("chunks");
  expect(lines[2].result.stopReason).toBe("final_response");
  expect(lines[2].result.finalOutput.length).toBe(8192);
  expect(lines[2].result.evidenceComplete).toBe(false);
});

test("RPC decoder rejects interrupted, mismatched and invalid chunk sequences", () => {
  const bytes = Buffer.from(JSON.stringify({ type: "response", text: "é".repeat(600000) }));
  const count = Math.ceil(bytes.length / 262144);
  const chunks = Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "c",
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * 262144, (index + 1) * 262144).toString("base64"),
  }));
  const decoder = new OmpFrameDecoder();
  let result: OmpFrame | undefined;
  for (const chunk of chunks) result = decoder.push(chunk);
  expect(result?.text).toBe("é".repeat(600000));
  const interrupted = new OmpFrameDecoder();
  interrupted.push(chunks[0]);
  expect(() => interrupted.push({ type: "session_settled" })).toThrow("interrupted");
  const missing = new OmpFrameDecoder();
  missing.push(chunks[0]);
  expect(() => missing.finish()).toThrow("Incomplete");
  const mismatch = new OmpFrameDecoder();
  mismatch.push(chunks[0]);
  expect(() => mismatch.push(chunks[2])).toThrow("mismatch");
  expect(() => new OmpFrameDecoder().push({ ...chunks[0], data: "%%%" })).toThrow();
  expect(() => new OmpFrameDecoder().push({ ...chunks[0], byteLength: 67108865 })).toThrow();
});
test("RPC byte reader rejects oversized and partial physical frames", async () => {
  for (const bytes of [Buffer.from("x".repeat(1048576)), Buffer.from('{"type":"ready"}')]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const consume = async () => {
      for await (const _frame of ompFrames(stream, new OmpFrameDecoder())) {
      }
    };
    await expect(consume()).rejects.toThrow();
  }
});
