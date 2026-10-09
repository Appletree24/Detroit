const result = await Bun.build({
  entrypoints: ["src/drivers/reference.ts", "src/drivers/verifier.ts", "src/drivers/omp.ts"],
  outdir: "dist",
  target: "bun",
  minify: false,
  sourcemap: "none",
});
if (!result.success) throw new AggregateError(result.logs, "Driver build failed");
console.log("Built dist/reference.js, dist/verifier.js and dist/omp.js");

export {};
