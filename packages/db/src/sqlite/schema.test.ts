import { describe, expect, test } from "bun:test";
import {
  activeRemoteJobs,
  agentConfig,
  inboundDispatchPending,
  localJobs,
  outboundHeartbeat,
  outboundJobStatus,
  outboundQueueValidationShadowRejection,
  outboundSoftwareOperationResult,
  queuedOperations,
} from "./schema";

describe("SQLite Schema", () => {
  test("queuedOperations has required columns", () => {
    expect(queuedOperations.id).toBeDefined();
    expect(queuedOperations.operationType).toBeDefined();
    expect(queuedOperations.payload).toBeDefined();
    expect(queuedOperations.idempotencyKey).toBeDefined();
    expect(queuedOperations.nextAttemptAt).toBeDefined();
  });

  test("localJobs has required columns", () => {
    expect(localJobs.jobId).toBeDefined();
    expect(localJobs.status).toBeDefined();
    expect(localJobs.command).toBeDefined();
    expect(localJobs.name).toBeDefined();
    expect(localJobs.gpus).toBeDefined();
    expect(localJobs.wallTimeSec).toBeDefined();
  });

  test("agentConfig has required columns", () => {
    expect(agentConfig.key).toBeDefined();
    expect(agentConfig.value).toBeDefined();
  });

  test("outboundJobStatus has required columns", () => {
    expect(outboundJobStatus.id).toBeDefined();
    expect(outboundJobStatus.jobId).toBeDefined();
    expect(outboundJobStatus.payload).toBeDefined();
    expect(outboundJobStatus.createdAt).toBeDefined();
  });

  test("outboundQueueValidationShadowRejection has durable event columns", () => {
    expect(outboundQueueValidationShadowRejection.eventId).toBeDefined();
    expect(outboundQueueValidationShadowRejection.failureCode).toBeDefined();
    expect(outboundQueueValidationShadowRejection.createdAt).toBeDefined();
  });

  test("outboundHeartbeat has required columns", () => {
    expect(outboundHeartbeat.id).toBeDefined();
    expect(outboundHeartbeat.payload).toBeDefined();
    expect(outboundHeartbeat.createdAt).toBeDefined();
  });

  test("outboundSoftwareOperationResult has required columns", () => {
    expect(outboundSoftwareOperationResult.id).toBeDefined();
    expect(outboundSoftwareOperationResult.operationId).toBeDefined();
    expect(outboundSoftwareOperationResult.payload).toBeDefined();
    expect(outboundSoftwareOperationResult.createdAt).toBeDefined();
  });

  test("inboundDispatchPending has required columns", () => {
    expect(inboundDispatchPending.id).toBeDefined();
    expect(inboundDispatchPending.dispatchId).toBeDefined();
    expect(inboundDispatchPending.jobId).toBeDefined();
    expect(inboundDispatchPending.payload).toBeDefined();
    expect(inboundDispatchPending.receivedAt).toBeDefined();
    expect(inboundDispatchPending.ackedAt).toBeDefined();
  });

  test("activeRemoteJobs has required columns", () => {
    expect(activeRemoteJobs.jobId).toBeDefined();
    expect(activeRemoteJobs.schedulerJobId).toBeDefined();
    expect(activeRemoteJobs.spec).toBeDefined();
    expect(activeRemoteJobs.expectedOutputs).toBeDefined();
    expect(activeRemoteJobs.createdAt).toBeDefined();
    expect(activeRemoteJobs.updatedAt).toBeDefined();
  });
});
