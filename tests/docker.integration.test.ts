import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cases, repairScript } from "../src/cases";
import { variantSchema } from "../src/contracts";
import { Docker } from "../src/sandbox/docker";

// These tests never replace Docker with local execution. Enable on a machine
// with the image already pulled: DETROIT_DOCKER_TESTS=1 bun test.
const integration = process.env.DETROIT_DOCKER_TESTS === "1" ? test : test.skip;
integration(
  "real Docker: repair -> collect -> fresh independent verifier",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "detroit-docker-"));
    try {
      const docker = new Docker();
      const image = await docker.resolveImage("oven/bun:1.4.2");
      const item = cases[0]!;
      const variant = variantSchema.parse({ id: "docker-smoke", provider: "scripted-repair" });
      const id = randomUUID();
      const output = await docker.run({
        item,
        directory,
        image,
        bundle: resolve("dist/reference.js"),
        request: {
          protocol_version: 1,
          attempt_id: id,
          instruction: item.instruction,
          variant,
          script: repairScript(item),
        },
        signal: new AbortController().signal,
      });
      expect(output.cleanup).toBe(true);
      expect(output.status).toBe("finished");
      expect(output.result?.stopReason).toBe("final_response");
      expect(output.files?.["index.mjs"]).toBe(item.solution);
      const score = await docker.verify({
        item,
        files: output.files!,
        image,
        directory,
        bundle: resolve("dist/verifier.js"),
        id,
      });
      expect(score.status).toBe("pass");
      const protectedScore = await docker.verify({
        item,
        files: {
          "index.mjs":
            "import {readFileSync} from 'node:fs';\nreadFileSync('/control/case.json');\n" +
            item.solution,
        },
        image,
        directory,
        bundle: resolve("dist/verifier.js"),
        id: `${id}-protected`,
      });
      expect(protectedScore.status).toBe("fail");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

integration(
  "real Docker: cancellation reclaims the whole attempt container",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "detroit-cancel-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const docker = new Docker();
      const image = await docker.resolveImage("oven/bun:1.4.2");
      const item = cases[0]!;
      const output = await docker.run({
        item,
        directory,
        image,
        bundle: resolve("dist/reference.js"),
        request: {
          protocol_version: 1,
          attempt_id: randomUUID(),
          instruction: "cancellation fixture",
          variant: variantSchema.parse({ id: "cancel", provider: "scripted-repair" }),
          script: [
            {
              content: "",
              toolCalls: [
                {
                  id: "sleep",
                  name: "shell",
                  arguments: '{"command":"sleep 30","timeout_ms":30000}',
                },
              ],
            },
          ],
        },
        signal: controller.signal,
      });
      expect(output.status).toBe("cancelled");
      expect(output.cleanup).toBe(true);
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
