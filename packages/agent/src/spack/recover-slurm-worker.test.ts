import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWorkerExecution, softwareExecution } from "./execution-identity";
import { SpackInstallStore } from "./install-store";
import { recoverSlurmSpackInstallation } from "./recover-slurm-worker";

test("recovery CLI helper reconciles only the original stopped worker and leaves release unpublished", async () => {
  const base = await mkdtemp(join(tmpdir(), "kq-reconcile-"));
  try {
    const cacheDir = join(base, "cache");
    const staging = join(cacheDir, "installs/run-test");
    await mkdir(join(staging, "input"), { recursive: true, mode: 0o700 });
    const store = new SpackInstallStore(join(base, "store"));
    await store.initialize();
    const operationId = randomUUID();
    const identity = {
      host: "a".repeat(64),
      boot: randomUUID(),
      pid: 2147480000,
      start: "1",
      token: randomUUID(),
    };
    let recordId = "";
    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const siteProfileDigest = `sha256:${"b".repeat(64)}`;
    await softwareExecution.run({ identity, operationId, bindStore: async () => {} }, () =>
      store.withLock(async () => {
        const record = await store.create({
          manifestDigest,
          manifestSize: 120,
          siteProfileDigest,
          spec: "zlib@1.3.1",
          rootHash: "a".repeat(32),
        });
        recordId = record.id;
        await installWorkerExecution.getStore()?.start(record.id, undefined, staging);
      }),
    );
    await writeFile(
      join(staging, "input/request.json"),
      JSON.stringify({
        action: "install",
        manifestDigest,
        siteProfileDigest,
        storePath: store.path(recordId),
      }),
      { mode: 0o400 },
    );
    const name = `kq-build-${randomUUID()}`;
    await writeFile(
      join(staging, "slurm.json"),
      JSON.stringify({ name, noRequeue: true, jobId: "123", binding: "a".repeat(64) }),
      { mode: 0o600 },
    );
    const calls: string[][] = [];
    await softwareExecution.run(
      {
        identity: { ...identity, pid: process.pid, token: randomUUID() },
        operationId: randomUUID(),
        bindStore: async () => {},
      },
      async () => {
        await recoverSlurmSpackInstallation({
          storeRoot: join(base, "store"),
          cacheDir,
          recordId,
          operationId,
          transport: {
            run: async (argv) => {
              calls.push(argv);
              if (argv[0]?.endsWith("sacct"))
                expect(argv).toContain("--format=JobIDRaw,JobName%100,State%64,ExitCode");
              if (argv[0]?.endsWith("scontrol"))
                return {
                  exitCode: 1,
                  stdout: "",
                  stderr: "slurm_load_jobs error: Invalid job id specified",
                };
              return {
                exitCode: 0,
                stdout: argv[0]?.endsWith("sacct") ? `123|${name}|OUT_OF_MEMORY|0:9\n` : "",
                stderr: "",
              };
            },
          },
        });
        expect((await store.list())[0]).toMatchObject({
          state: "failed",
          operationId,
          workerStopped: {
            schedulerJobId: "123",
            schedulerJobName: name,
            schedulerState: "OUT_OF_MEMORY",
            noRequeue: true,
            manifestDigest,
            siteProfileDigest,
            storePath: store.path(recordId),
          },
        });
        await store.withLock(async () => {});
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls.some((argv) => argv[0]?.endsWith("sbatch"))).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
