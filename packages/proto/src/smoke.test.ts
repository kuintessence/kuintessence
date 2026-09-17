import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as proto from "./index";

describe("proto package exports", () => {
  test("AgentService is exported", () => {
    expect(proto.AgentService).toBeDefined();
    expect(proto.AgentService.typeName).toBe("kuintessence.v1.AgentService");
  });

  test("AgentService has Connect rpc method", () => {
    expect(proto.AgentService.method.connect).toBeDefined();
  });

  test("message schemas are exported", () => {
    expect(proto.AgentMessageSchema).toBeDefined();
    expect(proto.ServerMessageSchema).toBeDefined();
    expect(proto.RegisterRequestSchema).toBeDefined();
    expect(proto.RegisterResponseSchema).toBeDefined();
    expect(proto.HeartbeatSchema).toBeDefined();
    expect(proto.HeartbeatAckSchema).toBeDefined();
    expect(proto.DispatchJobSchema).toBeDefined();
    expect(proto.CancelJobSchema).toBeDefined();
    expect(proto.JobLogsRequestSchema).toBeDefined();
    expect(proto.JobLogsResponseSchema).toBeDefined();
    expect(proto.JobStatusUpdateSchema).toBeDefined();
    expect(proto.JobStatusAckSchema).toBeDefined();
    expect(proto.QueueInventorySchema).toBeDefined();
    expect(proto.SchedulerQueueFactSchema).toBeDefined();
    expect(proto.QueueValidationShadowRejectionSchema).toBeDefined();
    expect(proto.QueueValidationShadowRejectionAckSchema).toBeDefined();
    expect(proto.JobWorkRootReleaseAckSchema).toBeDefined();
    expect(proto.DataScanRequestSchema).toBeDefined();
    expect(proto.DataScanResultSchema).toBeDefined();
    expect(proto.DataScanFileSchema).toBeDefined();
  });

  test("software governance and monitoring schemas are exported", () => {
    expect(proto.InstalledSpecSchema).toBeDefined();
    expect(proto.GpuMetricSchema).toBeDefined();
    expect(proto.MirrorSpecSchema).toBeDefined();
    expect(proto.InstalledSoftwareReportSchema).toBeDefined();
    expect(proto.SoftwarePolicyUpdateSchema).toBeDefined();
    expect(proto.SoftwarePolicyAckSchema).toBeDefined();
    expect(proto.SpecDistributeSchema).toBeDefined();
    expect(proto.SoftwareOperationRequestSchema).toBeDefined();
    expect(proto.SoftwareOperationResultSchema).toBeDefined();
    expect(proto.SoftwareOperationAction).toBeDefined();
    expect(proto.SoftwareOperationStatus).toBeDefined();
  });

  test("SchedulerType and JobStatus enums are exported", () => {
    // Both should be accessible via the barrel
    expect(proto.SchedulerType).toBeDefined();
    expect(proto.JobStatus).toBeDefined();
    // Sanity check: SchedulerType has SLURM
    expect(proto.SchedulerType.SLURM).toBeDefined();
    // Sanity check: JobStatus has RUNNING
    expect(proto.JobStatus.RUNNING).toBeDefined();
  });

  test("queue inventory and dispatch enums are exported", () => {
    expect(proto.QueueInventoryStatus.AVAILABLE).toBeDefined();
    expect(proto.SchedulerQueueType.PARTITION).toBeDefined();
    expect(proto.SchedulerQueueState.UP).toBeDefined();
    expect(proto.QueueTargetMode.DEFAULT).toBeDefined();
    expect(proto.QueueValidationMode.ENFORCE).toBeDefined();
  });
});

describe("queue protocol compatibility", () => {
  test("decodes a legacy DispatchJob payload with new fields left unspecified", () => {
    const legacyPayload = Uint8Array.from([
      0x0a,
      0x0a,
      ...new TextEncoder().encode("legacy-job"),
      0x62,
      0x05,
      ...new TextEncoder().encode("batch"),
    ]);
    const decoded = fromBinary(proto.DispatchJobSchema, legacyPayload);
    expect(decoded.jobId).toBe("legacy-job");
    expect(decoded.queueName).toBe("batch");
    expect(decoded.queueTargetMode).toBe(proto.QueueTargetMode.UNSPECIFIED);
    expect(decoded.queueValidationMode).toBe(proto.QueueValidationMode.UNSPECIFIED);
  });

  test("round-trips additive capability, inventory, and queue failure fields", () => {
    const registration = create(proto.RegisterRequestSchema, {
      agentId: "agent-1",
      queueInventoryV1: true,
    });
    const registrationWire = toBinary(proto.RegisterRequestSchema, registration);
    expect([...registrationWire]).toEqual(expect.arrayContaining([0x88, 0x01, 0x01]));
    expect(fromBinary(proto.RegisterRequestSchema, registrationWire).queueInventoryV1).toBe(true);

    const heartbeat = create(proto.HeartbeatSchema, {
      agentId: "agent-1",
      queueInventory: create(proto.QueueInventorySchema, {
        status: proto.QueueInventoryStatus.AVAILABLE,
        defaultQueueName: "batch",
        observedAtUnixMs: BigInt(1_755_561_600_000),
        queues: [
          create(proto.SchedulerQueueFactSchema, {
            queueName: "batch",
            queueType: proto.SchedulerQueueType.PARTITION,
            isDefault: true,
            state: proto.SchedulerQueueState.UP,
            acceptsSubmissions: true,
            observedAtUnixMs: BigInt(1_755_561_600_000),
          }),
        ],
      }),
    });
    const decodedHeartbeat = fromBinary(
      proto.HeartbeatSchema,
      toBinary(proto.HeartbeatSchema, heartbeat),
    );
    expect(decodedHeartbeat.queueInventory?.defaultQueueName).toBe("batch");

    const dispatch = create(proto.DispatchJobSchema, {
      queueName: "batch",
      queueTargetMode: proto.QueueTargetMode.NAMED,
      queueValidationMode: proto.QueueValidationMode.ENFORCE,
    });
    const decodedDispatch = fromBinary(
      proto.DispatchJobSchema,
      toBinary(proto.DispatchJobSchema, dispatch),
    );
    expect(decodedDispatch.queueTargetMode).toBe(proto.QueueTargetMode.NAMED);
    expect(decodedDispatch.queueValidationMode).toBe(proto.QueueValidationMode.ENFORCE);

    const status = create(proto.JobStatusUpdateSchema, { failureCode: "QUEUE_NOT_ACCEPTING" });
    expect(
      fromBinary(proto.JobStatusUpdateSchema, toBinary(proto.JobStatusUpdateSchema, status))
        .failureCode,
    ).toBe("QUEUE_NOT_ACCEPTING");

    const shadowRejection = create(proto.QueueValidationShadowRejectionSchema, {
      failureCode: "QUEUE_CHANGED",
      eventId: "shadow-event-1",
    });
    expect(
      fromBinary(
        proto.QueueValidationShadowRejectionSchema,
        toBinary(proto.QueueValidationShadowRejectionSchema, shadowRejection),
      ),
    ).toMatchObject({ failureCode: "QUEUE_CHANGED", eventId: "shadow-event-1" });

    const shadowAck = create(proto.QueueValidationShadowRejectionAckSchema, {
      eventId: "shadow-event-1",
    });
    expect(
      fromBinary(
        proto.QueueValidationShadowRejectionAckSchema,
        toBinary(proto.QueueValidationShadowRejectionAckSchema, shadowAck),
      ).eventId,
    ).toBe("shadow-event-1");
  });
});
