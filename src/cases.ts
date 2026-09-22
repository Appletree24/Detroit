import { type Case, caseSchema, type DriverRequest } from "./contracts";
import { digest } from "./evidence";

const define = (
  input: Omit<Case, "version" | "split" | "source" | "files"> & { initial: string },
): Case => {
  const { initial, ...rest } = input;
  return caseSchema.parse({
    ...rest,
    version: 1,
    split: "dev",
    source: "Detroit original synthetic fixture",
    files: {
      "index.mjs": initial,
      "visible-test.mjs": `import assert from 'node:assert/strict';\nimport { ${input.exportName} as fn } from './index.mjs';\nassert.deepEqual(fn(...${JSON.stringify(input.checks[0]!.args)}), ${JSON.stringify(input.checks[0]!.expected)});\nconsole.log('visible test passed');\n`,
    },
  });
};
export const cases: Case[] = [
  define({
    id: "clamp",
    family: "numeric-boundaries",
    entrypoint: "index.mjs",
    exportName: "clamp",
    instruction:
      "Fix clamp(value, min, max) in index.mjs. For finite numbers and min <= max, return value constrained to the inclusive range. Preserve in-range values, including negative values.",
    initial: "export const clamp = (value, min, max) => Math.min(min, Math.max(max, value));\n",
    solution: "export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));\n",
    checks: [
      { name: "in range", args: [5, 0, 10], expected: 5 },
      { name: "lower bound", args: [-3, 0, 10], expected: 0 },
      { name: "upper bound", args: [13, 0, 10], expected: 10 },
      { name: "negative range", args: [-4, -8, -2], expected: -4 },
      { name: "equal endpoints", args: [20, 7, 7], expected: 7 },
    ],
  }),
  define({
    id: "unique",
    family: "ordered-collections",
    entrypoint: "index.mjs",
    exportName: "unique",
    instruction:
      "Fix unique(values) in index.mjs. Return distinct strings in first-occurrence order. Do not mutate the input array. Handle the empty array and names such as __proto__.",
    initial: "export const unique = values => [...new Set(values)].sort();\n",
    solution: "export const unique = values => [...new Set(values)];\n",
    checks: [
      { name: "first occurrence order", args: [["b", "a", "b"]], expected: ["b", "a"] },
      { name: "empty", args: [[]], expected: [] },
      {
        name: "prototype names",
        args: [["__proto__", "x", "__proto__"]],
        expected: ["__proto__", "x"],
      },
      { name: "case sensitive", args: [["a", "A", "a", ""]], expected: ["a", "A", ""] },
    ],
  }),
  define({
    id: "chunk",
    family: "sequence-partitioning",
    entrypoint: "index.mjs",
    exportName: "chunk",
    instruction:
      "Fix chunk(values, size) in index.mjs. size is a positive integer. Return consecutive chunks of at most size items, including a final partial chunk; empty input returns []. Do not mutate the input.",
    initial:
      "export const chunk = (values, size) => { const out = []; for (let i = 0; i + size <= values.length; i += size) out.push(values.slice(i, i + size)); return out; };\n",
    solution:
      "export const chunk = (values, size) => { const out = []; for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size)); return out; };\n",
    checks: [
      { name: "partial tail", args: [[1, 2, 3], 2], expected: [[1, 2], [3]] },
      { name: "empty", args: [[], 2], expected: [] },
      { name: "large size", args: [[1], 4], expected: [[1]] },
      {
        name: "exact division",
        args: [[1, 2, 3, 4], 2],
        expected: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
  }),
  define({
    id: "mean",
    family: "numeric-aggregation",
    entrypoint: "index.mjs",
    exportName: "mean",
    instruction:
      "Fix mean(values) in index.mjs. Return the arithmetic mean of finite numbers, without rounding. Empty input returns null. Do not mutate the input.",
    initial:
      "export const mean = values => values.length ? Math.floor(values.reduce((a, b) => a + b, 0) / values.length) : 0;\n",
    solution:
      "export const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;\n",
    checks: [
      { name: "fractional result", args: [[1, 2]], expected: 1.5 },
      { name: "empty", args: [[]], expected: null },
      { name: "negative result", args: [[-2, -3]], expected: -2.5 },
      { name: "zeros", args: [[0, 0]], expected: 0 },
    ],
  }),
  define({
    id: "slug",
    family: "text-normalization",
    entrypoint: "index.mjs",
    exportName: "slug",
    instruction:
      "Fix slug(text) in index.mjs for ASCII input. Lowercase letters; replace each run of non-alphanumeric characters with a single hyphen; remove leading and trailing hyphens. Empty or punctuation-only input returns an empty string.",
    initial: "export const slug = text => text.toLowerCase().replaceAll(' ', '-');\n",
    solution:
      "export const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n",
    checks: [
      { name: "repeated separators", args: ["Hello,  World!"], expected: "hello-world" },
      { name: "empty", args: [""], expected: "" },
      { name: "punctuation", args: ["---!?___"], expected: "" },
      { name: "digits preserved", args: [" v2.0/API "], expected: "v2-0-api" },
    ],
  }),
];
export const getCase = (id: string) => {
  const item = cases.find((item) => item.id === id);
  if (!item) throw new Error(`Unknown case: ${id}`);
  return item;
};
export function repairScript(item: Case): NonNullable<DriverRequest["script"]> {
  return [
    {
      content: "",
      toolCalls: [
        { id: "read-1", name: "read_file", arguments: JSON.stringify({ path: item.entrypoint }) },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "patch-1",
          name: "apply_patch",
          arguments: JSON.stringify({
            path: item.entrypoint,
            expected_digest: digest(item.files[item.entrypoint]!),
            old: item.files[item.entrypoint],
            replacement: item.solution,
          }),
        },
      ],
    },
    {
      content: "",
      toolCalls: [
        {
          id: "test-1",
          name: "shell",
          arguments: JSON.stringify({ command: "bun visible-test.mjs" }),
        },
      ],
    },
    { content: "Synthetic fixture repair completed.", toolCalls: [] },
  ];
}
