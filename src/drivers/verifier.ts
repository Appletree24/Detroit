// Only public invocation inputs enter this process. Expected values and assertions
// stay in the host supervisor; the candidate workspace is mounted read-only.
process.stdout.write("DETROIT_WORKER_READY\n");
const input = JSON.parse(await Bun.stdin.text()) as {
  entrypoint: string;
  exportName: string;
  args: unknown[][];
};
try {
  const mod = await import(input.entrypoint);
  const values = [];
  for (const args of input.args) {
    const before = JSON.stringify(args);
    try {
      const value = await mod[input.exportName](...args);
      values.push({ ok: true, value, mutated: JSON.stringify(args) !== before });
    } catch (error) {
      values.push({ ok: false, error: String(error) });
    }
  }
  process.stdout.write(JSON.stringify(values));
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}

export {};
