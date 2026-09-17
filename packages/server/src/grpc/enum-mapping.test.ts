import { describe, expect, test } from "bun:test";
import { JobStatus as ProtoJobStatus, SchedulerType } from "@kuintessence/proto";
import { protoToJobStatus, protoToSchedulerType } from "./enum-mapping";

describe("protoToSchedulerType", () => {
  test("maps known scheduler types", () => {
    expect(protoToSchedulerType(SchedulerType.SLURM)).toBe("slurm");
    expect(protoToSchedulerType(SchedulerType.PBS_PRO)).toBe("pbs-pro");
    expect(protoToSchedulerType(SchedulerType.TORQUE)).toBe("torque");
    expect(protoToSchedulerType(SchedulerType.KUBERNETES)).toBe("kubernetes");
  });

  test("throws on UNSPECIFIED", () => {
    expect(() => protoToSchedulerType(SchedulerType.UNSPECIFIED)).toThrow();
  });
});

describe("protoToJobStatus", () => {
  test("maps known statuses", () => {
    expect(protoToJobStatus(ProtoJobStatus.PENDING)).toBe("pending");
    expect(protoToJobStatus(ProtoJobStatus.QUEUED)).toBe("queued");
    expect(protoToJobStatus(ProtoJobStatus.RUNNING)).toBe("running");
    expect(protoToJobStatus(ProtoJobStatus.COMPLETED)).toBe("completed");
    expect(protoToJobStatus(ProtoJobStatus.FAILED)).toBe("failed");
    expect(protoToJobStatus(ProtoJobStatus.CANCELLED)).toBe("cancelled");
  });

  test("throws on UNSPECIFIED", () => {
    expect(() => protoToJobStatus(ProtoJobStatus.UNSPECIFIED)).toThrow();
  });
});
