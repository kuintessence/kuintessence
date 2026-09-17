import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SlurmAdapter } from "../../src/adapters/slurm";
import { ContainerSpawner } from "../../src/adapters/spawner-container";
import { makeContainerMkdir, makeContainerReadOutput } from "../../src/container-io";
import { createOutputCollector } from "../../src/output-collector";
import { type SlurmCluster, startSlurmCluster } from "../fixtures/slurm-cluster";

let cluster: SlurmCluster;
let adapter: SlurmAdapter;

function validatedReader() {
  const reader = makeContainerReadOutput(cluster.containerId).readValidated;
  if (!reader) {
    throw new Error("Container output reader must provide atomic validation and reading");
  }
  return reader;
}

beforeAll(async () => {
  cluster = await startSlurmCluster();
  adapter = new SlurmAdapter("21.08.5", {
    spawner: new ContainerSpawner(cluster.containerId),
    logDir: "/var/tmp/kq-slurm-shared",
    terminalStatusBackend: "scontrol",
  });
}, 180_000);

afterAll(async () => {
  await cluster?.stop();
});

describe("container-io — real container", () => {
  test("mkdir creates a nested run directory", async () => {
    const dir = "/var/tmp/kq-slurm-shared/io-mkdir-test/nested";
    await makeContainerMkdir(cluster.containerId)(dir);
    const probe = await cluster.exec(["test", "-d", dir]);
    expect(probe.exitCode).toBe(0);
  }, 30_000);

  test("readOutput throws (not silently empty) for a missing file", async () => {
    await expect(
      makeContainerReadOutput(cluster.containerId)("/var/tmp/kq-slurm-shared/does-not-exist.txt"),
    ).rejects.toThrow(/readOutput failed/);
  }, 30_000);

  test("container reader accepts a regular output under a non-symlink work root", async () => {
    const workRoot = "/var/tmp/kq-slurm-shared/io-validator-regular";
    const output = `${workRoot}/result.txt`;
    await cluster.exec(["sh", "-c", 'mkdir -p "$1" && printf value > "$2"', "_", workRoot, output]);

    await expect(validatedReader()(output, workRoot, [])).resolves.toBe("value");
  }, 30_000);

  test("container reader rejects symlinked work roots and output files", async () => {
    const base = "/var/tmp/kq-slurm-shared/io-validator-symlink";
    const realRoot = `${base}/real`;
    const linkedRoot = `${base}/linked-root`;
    const output = `${realRoot}/result.txt`;
    const linkedOutput = `${realRoot}/linked-result.txt`;
    await cluster.exec([
      "sh",
      "-c",
      'rm -rf "$1" && mkdir -p "$2" && printf value > "$3" && ln -s "$2" "$4" && ln -s "$3" "$5"',
      "_",
      base,
      realRoot,
      output,
      linkedRoot,
      linkedOutput,
    ]);
    const readValidated = validatedReader();

    await expect(readValidated(output, linkedRoot, [])).rejects.toThrow(/work root/);
    await expect(readValidated(linkedOutput, realRoot, [])).rejects.toThrow(/symbolic links/);
  }, 30_000);

  test("container reader rejects a regular output outside the canonical work root", async () => {
    const base = "/var/tmp/kq-slurm-shared/io-validator-outside";
    const workRoot = `${base}/work`;
    const outsideOutput = `${base}/outside.txt`;
    await cluster.exec([
      "sh",
      "-c",
      'rm -rf "$1" && mkdir -p "$2" && printf value > "$3"',
      "_",
      base,
      workRoot,
      outsideOutput,
    ]);

    await expect(validatedReader()(outsideOutput, workRoot, [])).rejects.toThrow(
      /escapes the job work root/,
    );
  }, 30_000);

  test("container reader rejects direct and canonical protected output paths", async () => {
    const base = "/var/tmp/kq-slurm-shared/io-validator-protected";
    const workRoot = `${base}/work`;
    const directRoot = `${workRoot}/inputs/restricted`;
    const canonicalRoot = `${workRoot}/licensed-store`;
    const alias = `${workRoot}/inputs/licensed-alias`;
    const directOutput = `${directRoot}/direct.txt`;
    const canonicalOutput = `${canonicalRoot}/canonical.txt`;
    await cluster.exec([
      "sh",
      "-c",
      'rm -rf "$1" && mkdir -p "$2" "$3" "$4" && printf direct > "$5" && printf canonical > "$6" && ln -s "$4" "$7"',
      "_",
      base,
      workRoot,
      directRoot,
      canonicalRoot,
      directOutput,
      canonicalOutput,
      alias,
    ]);
    const readValidated = validatedReader();

    await expect(readValidated(directOutput, workRoot, [directRoot])).rejects.toThrow(/protected/);
    await expect(readValidated(canonicalOutput, workRoot, [alias])).rejects.toThrow(/protected/);
  }, 30_000);

  test("container reader validates artifact paths without collecting their contents", async () => {
    const workRoot = "/var/tmp/kq-slurm-shared/io-validator-path-only";
    const output = `${workRoot}/artifact.tar.gz`;
    await cluster.exec([
      "sh",
      "-c",
      'mkdir -p "$1" && printf artifact > "$2"',
      "_",
      workRoot,
      output,
    ]);
    const validatePath = makeContainerReadOutput(cluster.containerId).validatePath;
    if (!validatePath) {
      throw new Error("Container output reader must provide path-only validation");
    }

    await expect(validatePath(output, workRoot, [])).resolves.toBeUndefined();
    await expect(validatePath(output, workRoot, [workRoot])).rejects.toThrow(/protected/);
  }, 30_000);

  // End-to-end: a real Slurm job writes an output file into its run dir, and the
  // production collector (container reader + path resolution) reads it back —
  // the path the Server depends on for workflow value extraction.
  test("collects a real job's output file via the container reader", async () => {
    const submit = await adapter.submit({
      jobId: "out-collect-1",
      name: "out-collect",
      command: "echo 0.999 > kq-collect-test.txt",
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 300,
      workingDir: "/tmp",
      envVars: {},
    });
    const deadline = Date.now() + 30_000;
    let status = await adapter.status(submit.schedulerJobId);
    while (Date.now() < deadline && status.status !== "completed" && status.status !== "failed") {
      await Bun.sleep(1000);
      status = await adapter.status(submit.schedulerJobId);
    }
    expect(status.status).toBe("completed");

    const collect = createOutputCollector(makeContainerReadOutput(cluster.containerId));
    const collected = await collect(
      [{ descriptor: "residual", path: "kq-collect-test.txt", isBatch: false }],
      "/tmp",
    );
    expect(collected.residual).toBe("0.999\n");
  }, 60_000);
});
