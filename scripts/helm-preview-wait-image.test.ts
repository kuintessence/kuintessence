import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const enabled = process.env.KQ_RUN_CONTAINER_CONTRACTS === "1";
const valuesPath = fileURLToPath(new URL("../deploy/helm/kq-preview/values.yaml", import.meta.url));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected structured image configuration");
  }
  return value as Record<string, unknown>;
}

async function waitImages() {
  const values = record(record(parse(await readFile(valuesPath, "utf8")))["kq-platform"]);
  const migration = record(values.migration).waitImage;
  const bootstrap = record(values.rustfs).bootstrapWaitImage;
  if (typeof migration !== "string" || typeof bootstrap !== "string") {
    throw new Error("Expected explicit wait image references");
  }
  return { migration, bootstrap };
}

describe("preview workload wait image", () => {
  test("uses the same explicit compatibility image for both initialization barriers", async () => {
    const values = await waitImages();
    expect(values.migration).toBe("docker.io/bitnamilegacy/kubectl:1.32.3");
    expect(values.bootstrap).toBe(values.migration);
  });

  test.skipIf(!enabled)(
    "anonymously pulls amd64 and runs the existing shell and kubectl wait interface",
    async () => {
      const values = await waitImages();
      const docker = Bun.which("docker");
      if (!docker) throw new Error("Container contracts require Docker in Actions");
      const output = execFileSync(
        docker,
        [
          "run",
          "--rm",
          "--pull=always",
          "--platform=linux/amd64",
          "--network=none",
          "--entrypoint=/bin/sh",
          values.migration,
          "-ec",
          "command -v sleep >/dev/null; kubectl wait --help >/dev/null; kubectl version --client=true --output=json",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 180000,
          killSignal: "SIGKILL",
        },
      );
      expect(record(record(JSON.parse(output)).clientVersion).gitVersion).toBe("v1.32.3");
    },
    210000,
  );
});
