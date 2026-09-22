const result = await Bun.build({
  entrypoints: ["src/drivers/reference.ts", "src/drivers/verifier.ts"],
  outdir: "dist",
  target: "bun",
  minify: false,
  sourcemap: "none",
});
if (!result.success) throw new AggregateError(result.logs, "Driver build failed");
console.log("Built dist/reference.js and dist/verifier.js");

export {};
