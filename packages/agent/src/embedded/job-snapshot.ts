import { createHash } from "node:crypto";
import {
  JobSchedulerLimitsSchema,
  QueueTargetModeSchema,
  QueueValidationModeSchema,
  SchedulerAccountingSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import type { JobSpec, JobStatusResult } from "../adapters/base";
import type { ExpectedOutput, ProtectedPathMount } from "../output-collector";
import { SandboxJobSpecSchema } from "../sandbox/job-spec";

export const PENDING_SCHEDULER_SUBMISSION = "__kq_submission_pending__";

export interface CompletedJobSnapshot {
  format: 1;
  schedulerJobId: string;
  binding: string;
  result: JobStatusResult & { status: "completed" };
}

export interface PreparedRemoteJob {
  spec: JobSpec;
  expectedOutputs: ExpectedOutput[];
}

export function preparedRemoteJobToJson(input: PreparedRemoteJob): Record<string, unknown> {
  return {
    spec: jobSpecToJson(input.spec),
    expectedOutputs: input.expectedOutputs.map(expectedOutputToJson),
  };
}

export function jsonToPreparedRemoteJob(value: unknown): PreparedRemoteJob {
  const parsed = z
    .object({
      spec: z.record(z.string(), z.unknown()),
      expectedOutputs: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(value);
  return {
    spec: jsonToJobSpec(parsed.spec),
    expectedOutputs: parsed.expectedOutputs.map(jsonToExpectedOutput),
  };
}

export function completionBinding(
  spec: JobSpec,
  schedulerJobId: string,
  outputs: ExpectedOutput[],
): string {
  const normalized = jsonToJobSpec(jobSpecToJson(spec));
  const stableSpec = {
    ...jobSpecToJson(normalized),
    envVars: Object.fromEntries(
      Object.entries(normalized.envVars).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        spec: stableSpec,
        schedulerJobId,
        outputs: outputs.map((output) =>
          expectedOutputToJson(jsonToExpectedOutput(expectedOutputToJson(output))),
        ),
      }),
    )
    .digest("hex");
}

export function validateCompletionSnapshot(
  value: unknown,
  spec: JobSpec,
  schedulerJobId: string,
  expectedOutputs: ExpectedOutput[],
): CompletedJobSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    schedulerJobId === PENDING_SCHEDULER_SUBMISSION ||
    !schedulerJobId
  )
    throw new Error("Invalid completed job snapshot");
  const snapshot = value as Record<string, unknown>;
  const result = snapshot.result;
  if (
    Object.keys(snapshot).some(
      (key) => !["format", "schedulerJobId", "binding", "result"].includes(key),
    ) ||
    snapshot.format !== 1 ||
    snapshot.schedulerJobId !== schedulerJobId ||
    snapshot.binding !== completionBinding(spec, schedulerJobId, expectedOutputs) ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  )
    throw new Error("Completed job snapshot binding mismatch");
  const fields = result as Record<string, unknown>;
  if (
    fields.status !== "completed" ||
    (fields.exitCode !== undefined &&
      (!Number.isSafeInteger(fields.exitCode) || Number(fields.exitCode) < 0)) ||
    ["message", "node", "reason", "startedAt"].some(
      (key) => fields[key] !== undefined && typeof fields[key] !== "string",
    ) ||
    Object.keys(fields).some(
      (key) =>
        !["status", "exitCode", "message", "node", "reason", "startedAt", "accounting"].includes(
          key,
        ),
    )
  )
    throw new Error("Invalid completed job result");
  const accounting =
    fields.accounting === undefined
      ? undefined
      : SchedulerAccountingSchema.parse(fields.accounting);
  if (accounting && accounting.schedulerJobId !== schedulerJobId)
    throw new Error("Completed job accounting binding mismatch");
  return {
    format: 1,
    schedulerJobId,
    binding: String(snapshot.binding),
    result: {
      status: "completed",
      exitCode: fields.exitCode as number | undefined,
      message: fields.message as string | undefined,
      node: fields.node as string | undefined,
      reason: fields.reason as string | undefined,
      startedAt: fields.startedAt as string | undefined,
      accounting,
    },
  };
}

export function jobSpecToJson(spec: JobSpec): Record<string, unknown> {
  return { ...spec };
}

export function expectedOutputToJson(output: ExpectedOutput): Record<string, unknown> {
  return {
    descriptor: output.descriptor,
    path: output.path,
    isBatch: output.isBatch,
    pathsOnly: output.pathsOnly,
    protectedPaths: output.protectedPaths ? [...output.protectedPaths] : undefined,
    protectedMounts: output.protectedMounts?.map(protectedPathMountToJson),
  };
}

export function jsonToJobSpec(value: Record<string, unknown>): JobSpec {
  return {
    jobId: requireString(value.jobId, "jobId"),
    name: requireString(value.name, "name"),
    command: requireString(value.command, "command"),
    cpus: requireNumber(value.cpus, "cpus"),
    memoryMb: requireNumber(value.memoryMb, "memoryMb"),
    gpus: requireNumber(value.gpus, "gpus"),
    wallTimeSec: requireNumber(value.wallTimeSec, "wallTimeSec"),
    schedulerLimits: JobSchedulerLimitsSchema.optional().parse(value.schedulerLimits),
    workingDir: requireString(value.workingDir, "workingDir"),
    envVars: jsonToStringMap(value.envVars),
    queueName: optionalString(value.queueName),
    schedulerName: optionalString(value.schedulerName),
    forEachGroup: optionalString(value.forEachGroup),
    federationDispatchEpoch: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .parse(value.federationDispatchEpoch),
    queueTargetMode: QueueTargetModeSchema.optional().parse(value.queueTargetMode),
    queueValidationMode: QueueValidationModeSchema.optional().parse(value.queueValidationMode),
    sandbox: SandboxJobSpecSchema.optional().parse(value.sandbox),
    qos: optionalString(value.qos),
    stdinText: optionalString(value.stdinText),
    restrictedNoEgress: value.restrictedNoEgress === true,
    dataDeliveryCleanup: optionalDataDeliveryCleanup(value.dataDeliveryCleanup),
    licensedMaterialCleanup: optionalLicensedMaterialCleanup(value.licensedMaterialCleanup),
  };
}

export function jsonToExpectedOutput(value: Record<string, unknown>): ExpectedOutput {
  return {
    descriptor: requireString(value.descriptor, "descriptor"),
    path: requireString(value.path, "path"),
    isBatch: value.isBatch === true,
    pathsOnly: value.pathsOnly === true,
    protectedPaths: optionalStringArray(value.protectedPaths, "protectedPaths"),
    protectedMounts: optionalProtectedMounts(value.protectedMounts),
  };
}

function protectedPathMountToJson(mount: ProtectedPathMount): Record<string, unknown> {
  return {
    selectorId: mount.selectorId,
    sourcePath: mount.sourcePath,
    targetPath: mount.targetPath,
  };
}

function optionalProtectedMounts(value: unknown): ProtectedPathMount[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("active remote job protectedMounts must be an array");
  }
  return value.map((mount) => {
    if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
      throw new Error("active remote job protectedMounts entry is invalid");
    }
    return {
      selectorId: requireString(mount.selectorId, "protectedMounts.selectorId"),
      sourcePath: requireString(mount.sourcePath, "protectedMounts.sourcePath"),
      targetPath: requireString(mount.targetPath, "protectedMounts.targetPath"),
    };
  });
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`active remote job ${field} must be a string array`);
  }
  return value;
}

function optionalDataDeliveryCleanup(value: unknown): JobSpec["dataDeliveryCleanup"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error("active remote job dataDeliveryCleanup must be an array");
  return value.map((delivery) => {
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw new Error("active remote job dataDeliveryCleanup entry is invalid");
    }
    const method = requireString(delivery.method, "dataDeliveryCleanup.method");
    if (method !== "object-download" && method !== "stage-copy" && method !== "readonly-mount") {
      throw new Error("active remote job dataDeliveryCleanup method is invalid");
    }
    return {
      bindingId: requireString(delivery.bindingId, "dataDeliveryCleanup.bindingId"),
      targetPath: requireString(delivery.targetPath, "dataDeliveryCleanup.targetPath"),
      method,
    };
  });
}

function optionalLicensedMaterialCleanup(value: unknown): JobSpec["licensedMaterialCleanup"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("active remote job licensedMaterialCleanup must be an array");
  }
  return value.map((mount) => {
    if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
      throw new Error("active remote job licensedMaterialCleanup entry is invalid");
    }
    return {
      selectorId: requireString(mount.selectorId, "licensedMaterialCleanup.selectorId"),
      targetPath: requireString(mount.targetPath, "licensedMaterialCleanup.targetPath"),
      sourcePath: requireString(mount.sourcePath, "licensedMaterialCleanup.sourcePath"),
    };
  });
}

function jsonToStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("active remote job has invalid envVars");
  }
  const entries = Object.entries(value).map(([key, raw]) => {
    if (typeof raw !== "string") {
      throw new Error(`active remote job envVars.${key} must be a string`);
    }
    return [key, raw] as const;
  });
  return Object.fromEntries(entries);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`active remote job ${field} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`active remote job ${field} must be a number`);
  }
  return value;
}
