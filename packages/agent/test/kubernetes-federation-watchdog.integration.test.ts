import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import { DispatchJobSchema } from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { JobSpec } from "../src/adapters/base";
import { K8sAdapter } from "../src/adapters/k8s";
import {
  federationDispatchReceipt,
  federationSchedulerName,
} from "../src/queue/federation-dispatch";
import { InboundAcks } from "../src/queue/inbound-acks";

// Opt in only against an explicitly selected test cluster. All resources use a new namespace.
const enabled = process.env.KQ_TEST_KUBERNETES_WATCHDOG === "1";
async function kubectl(args: string[], stdin?: string): Promise<string> {
  const process = Bun.spawn(["kubectl", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`kubectl ${args[0]} failed: ${stderr}`);
  return stdout;
}
async function until(check: () => Promise<boolean>, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Kubernetes watchdog test timed out");
    await Bun.sleep(250);
  }
}

test.skipIf(!enabled)(
  "real Kubernetes watchdog stops expired work and cannot delete a same-name replacement",
  async () => {
    const namespace = `kq-watchdog-${crypto.randomUUID().slice(0, 8)}`;
    const directory = await mkdtemp(join(tmpdir(), "kq-k8s-watchdog-"));
    const path = join(directory, "agent.sqlite");
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    schema.runSqliteMigrations(sqlite);
    await chmod(path, 0o600);
    const db = drizzle(sqlite, { schema });
    const inbox = new InboundAcks(db);
    let guardian: ReturnType<typeof Bun.spawn> | undefined;
    let errorOutput: Promise<string> | undefined;
    const adapter = new K8sAdapter("test", {
      namespace,
      tmpDir: directory,
      defaultImage: process.env.KQ_TEST_KUBERNETES_IMAGE ?? "python:3.13-alpine",
    });
    const dispatch = create(DispatchJobSchema, {
      jobId: crypto.randomUUID(),
      dispatchEpoch: 9n,
      federationExecution: true,
    });
    const dispatchId = `${dispatch.jobId}:9`;
    const spec = {
      jobId: dispatch.jobId,
      name: "watchdog",
      schedulerName: federationSchedulerName(9n),
      federationDispatchEpoch: 9,
      command: "trap 'exit 0' TERM; sleep 120 & wait",
      cpus: 0.05,
      memoryMb: 32,
      gpus: 0,
      wallTimeSec: 120,
      workingDir: "/tmp",
      envVars: {},
      queueName: namespace,
    };
    try {
      await kubectl(["create", "namespace", namespace]);
      class MultiResourceAdapter extends K8sAdapter {
        override buildJobManifest(job: JobSpec): Record<string, unknown> {
          return {
            apiVersion: "v1",
            kind: "List",
            items: [
              {
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: "script", namespace },
                data: { script: "sleep 120" },
              },
              super.buildJobManifest(job),
            ],
          };
        }
      }
      const original = await new MultiResourceAdapter("test", {
        namespace,
        tmpDir: directory,
        defaultImage: process.env.KQ_TEST_KUBERNETES_IMAGE ?? "python:3.13-alpine",
      }).submit(spec);
      expect(original.schedulerUid).toBeDefined();
      if (!original.schedulerUid) throw new Error("No original UID");
      await kubectl([
        "wait",
        "pod",
        "-n",
        namespace,
        "-l",
        `controller-uid=${original.schedulerUid}`,
        "--for=condition=Ready",
        "--timeout=30s",
      ]);
      await inbox.persistInbound({
        dispatchId,
        jobId: spec.jobId,
        payload: {
          federationExecution: true,
          federationReceipt: federationDispatchReceipt(dispatch),
        },
      });
      await inbox.markSubmissionStarted(
        dispatchId,
        { spec, expectedOutputs: [] },
        { owner: "terminated-agent", expiresAt: Date.now() + 500, state: "active" },
      );
      await inbox.bindRuntimeSchedulerIdentity(dispatchId, {
        schedulerJobId: original.schedulerJobId,
        schedulerUid: original.schedulerUid,
        namespace,
      });
      await inbox.markAcked(dispatchId);
      guardian = Bun.spawn(
        [
          process.execPath,
          new URL("../src/index.ts", import.meta.url).pathname,
          "--federation-watchdog",
        ],
        {
          env: {
            ...process.env,
            AGENT_DB_PATH: path,
            AGENT_SPAWNER_BACKEND: "host",
            LOG_LEVEL: "error",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      errorOutput = new Response(guardian.stderr).text();
      await until(async () => {
        if (guardian?.exitCode !== null) throw new Error(`watchdog exited: ${await errorOutput}`);
        return inbox.hasConfirmedRuntimeStop(
          dispatchId,
          original.schedulerJobId,
          original.schedulerUid,
        );
      });
      expect(
        await adapter.confirmStopped(original.schedulerJobId, {
          jobId: spec.jobId,
          namespace,
          schedulerUid: original.schedulerUid,
        }),
      ).toBe(true);
      guardian.kill();
      await guardian.exited;
      // Repeat with an orphaned Pod and a replacement Job using the exact same name.
      const orphan = await adapter.submit(spec);
      await kubectl([
        "wait",
        "pod",
        "-n",
        namespace,
        "-l",
        `controller-uid=${orphan.schedulerUid}`,
        "--for=condition=Ready",
        "--timeout=30s",
      ]);
      await kubectl([
        "delete",
        "job",
        orphan.schedulerJobId,
        "-n",
        namespace,
        "--cascade=orphan",
        "--wait=true",
        "--timeout=10s",
      ]);
      const replacement = await adapter.submit(spec);
      expect(replacement.schedulerUid).not.toBe(orphan.schedulerUid);
      const lookup = {
        jobId: spec.jobId,
        namespace,
        schedulerUid: orphan.schedulerUid,
        federationDispatchEpoch: 9,
      };
      await expect(adapter.cancel(orphan.schedulerJobId, lookup)).rejects.toThrow(
        "conditional delete",
      );
      expect(await adapter.confirmStopped(orphan.schedulerJobId, lookup)).toBe(false);
      await kubectl([
        "delete",
        "pods",
        "-n",
        namespace,
        "-l",
        `controller-uid=${orphan.schedulerUid}`,
        "--wait=true",
        "--timeout=20s",
        "--grace-period=1",
      ]);
      expect(await adapter.confirmStopped(orphan.schedulerJobId, lookup)).toBe(true);
      const current = JSON.parse(
        await kubectl(["get", "job", replacement.schedulerJobId, "-n", namespace, "-o", "json"]),
      );
      expect(current.metadata.uid).toBe(replacement.schedulerUid);
      expect(current.metadata.deletionTimestamp).toBeUndefined();
    } finally {
      guardian?.kill();
      if (guardian) await guardian.exited;
      await errorOutput;
      sqlite.close();
      await kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
