import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  DataDeliveryBindingSchema,
  DispatchJobSchema,
  ExpectedOutputSchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import pino from "pino";
import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import { AgentStream } from "../stream";

const silent = pino({ level: "silent" });

function makeAdapter(submitted: JobSpec[]): SchedulerAdapter {
  return {
    type: "slurm",
    version: "23.02.7",
    submit: async (spec) => {
      submitted.push(spec);
      return { schedulerJobId: "scheduler-1" };
    },
    cancel: async () => {},
    status: async () => ({ status: "completed", exitCode: 0 }),
  };
}

describe("Data Market AgentStream work-root isolation", () => {
  test("preserves the staged workflow workingDir when no protected inputs are present", async () => {
    const collectedOutputs: Array<{
      pathsOnly?: boolean;
      protectedPaths?: readonly string[];
    }> = [];
    const submitted: JobSpec[] = [];
    let resolveCollection: () => void;
    const collectionDone = new Promise<void>((resolve) => {
      resolveCollection = resolve;
    });
    const client = {
      connect: () =>
        (async function* () {
          yield create(ServerMessageSchema, {
            payload: {
              case: "dispatchJob",
              value: create(DispatchJobSchema, {
                jobId: "job-1",
                name: "test",
                command: "true",
                cpus: 1,
                memoryMb: 128n,
                gpus: 0,
                wallTimeSec: 60n,
                workingDir: "/untrusted/from-server",
                envVars: {},
                expectedOutputs: [
                  create(ExpectedOutputSchema, {
                    descriptor: "result",
                    path: "result.txt",
                    isBatch: false,
                    pathsOnly: true,
                  }),
                ],
              }),
            },
          });
          await collectionDone;
        })(),
    };
    const stream = new AgentStream({
      client: client as never,
      adapter: makeAdapter(submitted),
      agentId: "agent-1",
      siteName: "test",
      heartbeatIntervalMs: 60_000,
      jobPollIntervalMs: 0,
      jobSleep: async () => {},
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
      prepareJobWorkRoot: async (jobId) => `/agent/jobs/${jobId}`,
      collectOutputs: async (outputs) => {
        collectedOutputs.push({
          pathsOnly: outputs[0]?.pathsOnly,
          protectedPaths: outputs[0]?.protectedPaths,
        });
        resolveCollection();
        return {};
      },
    });
    const running = stream.start();
    await collectionDone;
    stream.stop();
    await running;

    expect(submitted[0]?.workingDir).toBe("/untrusted/from-server");
    expect(collectedOutputs[0]?.pathsOnly).toBe(true);
    expect(collectedOutputs[0]?.protectedPaths).toBeUndefined();
  });

  test("replaces the Server workingDir for a Data Market delivery", async () => {
    const submitted: JobSpec[] = [];
    let resolveCollection: () => void;
    const collectionDone = new Promise<void>((resolve) => {
      resolveCollection = resolve;
    });
    const client = {
      connect: () =>
        (async function* () {
          yield create(ServerMessageSchema, {
            payload: {
              case: "dispatchJob",
              value: create(DispatchJobSchema, {
                jobId: "job-data-1",
                name: "data test",
                command: "true",
                cpus: 1,
                memoryMb: 128n,
                wallTimeSec: 60n,
                workingDir: "/server/staged/job-data-1",
                dataDeliveries: [create(DataDeliveryBindingSchema, {})],
                expectedOutputs: [
                  create(ExpectedOutputSchema, {
                    descriptor: "result",
                    path: "result.txt",
                  }),
                ],
              }),
            },
          });
          await collectionDone;
        })(),
    };
    const stream = new AgentStream({
      client: client as never,
      adapter: makeAdapter(submitted),
      agentId: "agent-1",
      siteName: "test",
      heartbeatIntervalMs: 60_000,
      jobPollIntervalMs: 0,
      jobSleep: async () => {},
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
      prepareJobWorkRoot: async (jobId) => `/agent/jobs/${jobId}`,
      dataDeliveryExecutor: {
        prepare: async () => [],
        recover: async () => {},
        release: async () => {},
      },
      collectOutputs: async () => {
        resolveCollection();
        return {};
      },
    });
    const running = stream.start();
    await collectionDone;
    stream.stop();
    await running;

    expect(submitted[0]?.workingDir).toBe("/agent/jobs/job-data-1");
  });
});
