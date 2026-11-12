import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createSqliteDb } from "@kuintessence/db";
import {
  type AgentMessage,
  DispatchJobSchema,
  ExpectedOutputSchema,
  JobStatus,
  type ServerMessage,
  ServerMessageSchema,
  SpackJobExecutionSchema,
} from "@kuintessence/proto";
import { SPACK_EXECUTION_PLACEHOLDER } from "@kuintessence/shared";
import pino from "pino";
import { SlurmAdapter } from "./adapters/slurm";
import { ActiveRemoteJobs } from "./queue/active-remote-jobs";
import { InboundAcks } from "./queue/inbound-acks";
import { OutboundQueue } from "./queue/outbound-queue";
import { SpackManager } from "./spack";
import { AgentStream, type AgentStreamDeps } from "./stream";

interface StreamInternals {
  running: boolean;
  connected: boolean;
  currentStreamController: AbortController;
  jobStatusAckSupported: boolean;
  handleServerMessage(message: ServerMessage): Promise<void>;
  generateOutbound(
    registration: Promise<boolean>,
    attempt: AbortController,
  ): AsyncGenerator<AgentMessage>;
}

for (const { live, spack } of [
  { live: true, spack: false },
  { live: false, spack: false },
  { live: true, spack: true },
  { live: false, spack: true },
]) {
  test(`${spack ? "Spack" : "raw"} implicit work root survives real Slurm submission and ${live ? "live reporting" : "restart replay"}`, async () => {
    const db = createSqliteDb(":memory:");
    const outbound = new OutboundQueue(db);
    const records = new ActiveRemoteJobs(db);
    const inbound = new InboundAcks(db);
    const scripts: string[] = [];
    const root = "/shared/managed/jobs/implicit-output";
    const adapter = new SlurmAdapter("23.02.7", {
      logDir: "/shared/managed/jobs/.scheduler-logs",
      spawner: {
        run: async (command, options) => {
          expect(command).toEqual(["sbatch", "--parsable"]);
          scripts.push(options?.stdin ?? "");
          return { exitCode: 0, stdout: "5142\n", stderr: "" };
        },
      },
    });
    adapter.status = async () => ({ status: "completed", exitCode: 0 });
    const spackManager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      spawner: { run: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }) },
    });
    spackManager.runSoftwareOperation = async () => ({
      outcome: "succeeded",
      stdout: "export KQ_ACTIVATED=1",
      installed: [],
    });
    const deps: AgentStreamDeps = {
      client: {} as AgentStreamDeps["client"],
      adapter,
      spackManager,
      spackActivationSpawner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      agentId: "agent",
      siteName: "fixture",
      heartbeatIntervalMs: 60_000,
      jobPollIntervalMs: 0,
      logger: pino({ level: "silent" }),
      outboundQueue: outbound,
      activeRemoteJobs: records,
      inboundAcks: inbound,
      prepareJobWorkRoot: async () => root,
      removeJobWorkRoot: async () => {
        throw new Error("successful outputs must await Server release");
      },
      collectOutputs: async (_outputs, workingDir) => {
        expect(workingDir).toBe(root);
        return { result: "one.txt" };
      },
    };
    const stream = new AgentStream(deps);
    const state = stream as unknown as StreamInternals;
    state.running = true;
    state.connected = live;
    let replay: AgentStream | undefined;
    let liveIterator: AsyncGenerator<AgentMessage> | undefined;
    let livePending: ReturnType<AsyncGenerator<AgentMessage>["next"]> | undefined;
    try {
      if (live) {
        const attempt = new AbortController();
        state.currentStreamController = attempt;
        state.jobStatusAckSupported = true;
        liveIterator = state.generateOutbound(Promise.resolve(true), attempt);
        expect((await liveIterator.next()).value?.payload.case).toBe("register");
        livePending = liveIterator.next();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await state.handleServerMessage(
        create(ServerMessageSchema, {
          payload: {
            case: "dispatchJob",
            value: create(DispatchJobSchema, {
              jobId: "implicit-output",
              name: "fixture",
              command: spack ? SPACK_EXECUTION_PLACEHOLDER : "true",
              ...(spack
                ? {
                    spackExecution: create(SpackJobExecutionSchema, {
                      spec: "hello@1.0",
                      command: "true",
                    }),
                  }
                : {}),
              cpus: 1,
              memoryMb: 64n,
              wallTimeSec: 60n,
              dispatchEpoch: 7n,
              expectedOutputs: [
                create(ExpectedOutputSchema, {
                  descriptor: "result",
                  path: "one.txt",
                  pathsOnly: true,
                }),
              ],
            }),
          },
        }),
      );
      for (let attempt = 0; attempt < 1000; attempt++) {
        const items = await outbound.loadForReplay();
        if (
          items.some(({ item }) => item.kind === "jobStatus" && item.report.status === "completed")
        )
          break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toContain(`#SBATCH --chdir=${root}\n`);
      expect(scripts[0]).toContain(
        "#SBATCH --output=/shared/managed/jobs/.scheduler-logs/kq-implicit-output.out",
      );
      if (spack) expect(scripts[0]).toContain("export KQ_ACTIVATED=1");
      const durable = (await outbound.loadForReplay()).filter(
        ({ item }) => item.kind === "jobStatus",
      );
      expect(
        durable.some(({ item }) => item.kind === "jobStatus" && item.report.status === "completed"),
      ).toBe(true);
      expect(
        durable.every(({ item }) => item.kind === "jobStatus" && item.report.workingDir === root),
      ).toBe(true);
      expect(await inbound.pendingInbound()).toEqual([]);

      if (!live) {
        await stream.stop();
        // New stream and queue instances read only the durable SQLite state.
        replay = new AgentStream({ ...deps, outboundQueue: new OutboundQueue(db) });
      }
      const sender = (replay ?? stream) as unknown as StreamInternals;
      const attempt = new AbortController();
      sender.running = true;
      if (!live) sender.currentStreamController = attempt;
      sender.jobStatusAckSupported = true;
      const iterator = liveIterator ?? sender.generateOutbound(Promise.resolve(true), attempt);
      if (!live) expect((await iterator.next()).value?.payload.case).toBe("register");
      const statuses: JobStatus[] = [];
      while (!statuses.includes(JobStatus.QUEUED) || !statuses.includes(JobStatus.COMPLETED)) {
        const next = livePending ?? iterator.next();
        livePending = undefined;
        const message = (await next).value;
        if (message?.payload.case !== "jobStatus") continue;
        expect(message.payload.value.workingDir).toBe(root);
        expect(message.payload.value.schedulerJobId).toBe("5142");
        statuses.push(message.payload.value.status);
      }
      await iterator.return(undefined);
      // Sending does not clear the durable terminal binding before explicit Server ACK.
      expect(
        (await outbound.loadForReplay()).some(
          ({ item }) => item.kind === "jobStatus" && item.report.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await replay?.stop();
      await stream.stop();
    }
  });
}
