import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../src/cases";
import { evaluate } from "../src/eval/verifier";
import { writeFiles } from "../src/sandbox/files";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "detroit-eval-"));
  dirs.push(dir);
  return dir;
}

for (const item of cases) {
  test(`${item.id}: original fails, reference passes all hidden assertions`, async () => {
    const dir = await fixture();
    await writeFiles(dir, item.files);
    expect((await evaluate(item, dir)).status).toBe("fail");
    await writeFile(join(dir, item.entrypoint), item.solution);
    const result = await evaluate(item, dir);
    expect(result.status).toBe("pass");
    expect(result.checks).toHaveLength(item.checks.length);
  });
}

test("editing visible tests cannot turn an incorrect candidate into a pass", async () => {
  const dir = await fixture();
  const item = cases[0]!;
  await writeFiles(dir, { ...item.files, "visible-test.mjs": "console.log('all passed')" });
  expect((await evaluate(item, dir)).status).toBe("fail");
});

test("candidate crash and timeout are failures; broken supervisor environment is evaluation_error", async () => {
  const dir = await fixture();
  const item = cases[0]!;
  await writeFiles(dir, { "index.mjs": "throw new Error('candidate crash')" });
  expect((await evaluate(item, dir)).status).toBe("fail");
  await writeFile(join(dir, "index.mjs"), "export function clamp() { while (true) {} }");
  expect((await evaluate(item, dir, { timeoutMs: 50 })).status).toBe("fail");
  expect((await evaluate(item, join(dir, "does-not-exist"))).status).toBe("evaluation_error");
});

test("argument mutation is detected even if return values match", async () => {
  const dir = await fixture();
  const item = cases.find((c) => c.id === "chunk")!;
  await writeFiles(dir, {
    "index.mjs":
      "export function chunk(a, n) { const r=[]; while(a.length)r.push(a.splice(0,n)); return r; }",
  });
  const result = await evaluate(item, dir);
  expect(result.status).toBe("fail");
  expect(result.checks[0]?.passed).toBe(false);
});

test("wrong solutions that pass the visible example are rejected", async () => {
  const dir = await fixture();
  const item = cases.find((c) => c.id === "mean")!;
  await writeFiles(dir, { "index.mjs": "export const mean = () => 1.5;" });
  const result = await evaluate(item, dir);
  expect(result.checks[0]?.passed).toBe(true);
  expect(result.status).toBe("fail");
});
