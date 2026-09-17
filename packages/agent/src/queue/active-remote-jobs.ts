import { activeRemoteJobs, type SqliteDb } from "@kuintessence/db";
import { asc, eq } from "drizzle-orm";
import type { JobSpec } from "../adapters/base";
import type { ExpectedOutput, ProtectedPathMount } from "../output-collector";

export interface ActiveRemoteJobRecord {
  jobId: string;
  schedulerJobId: string;
  spec: JobSpec;
  expectedOutputs: ExpectedOutput[];
}

export interface RecordSubmittedInput {
  spec: JobSpec;
  schedulerJobId: string;
  expectedOutputs: ExpectedOutput[];
}

export class ActiveRemoteJobs {
  constructor(private readonly db: SqliteDb) {}

  async recordSubmitted(input: RecordSubmittedInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(activeRemoteJobs)
      .values({
        jobId: input.spec.jobId,
        schedulerJobId: input.schedulerJobId,
        spec: jobSpecToJson(input.spec),
        expectedOutputs: input.expectedOutputs.map(expectedOutputToJson),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: activeRemoteJobs.jobId,
        set: {
          schedulerJobId: input.schedulerJobId,
          spec: jobSpecToJson(input.spec),
          expectedOutputs: input.expectedOutputs.map(expectedOutputToJson),
          updatedAt: now,
        },
      });
  }

  async listActive(): Promise<ActiveRemoteJobRecord[]> {
    const rows = await this.db
      .select()
      .from(activeRemoteJobs)
      .orderBy(asc(activeRemoteJobs.createdAt), asc(activeRemoteJobs.jobId));
    return rows.map((row) => ({
      jobId: row.jobId,
      schedulerJobId: row.schedulerJobId,
      spec: jsonToJobSpec(row.spec),
      expectedOutputs: row.expectedOutputs.map(jsonToExpectedOutput),
    }));
  }

  async markFinished(jobId: string): Promise<void> {
    await this.db.delete(activeRemoteJobs).where(eq(activeRemoteJobs.jobId, jobId));
  }
}

function jobSpecToJson(spec: JobSpec): Record<string, unknown> {
  return {
    jobId: spec.jobId,
    name: spec.name,
    command: spec.command,
    cpus: spec.cpus,
    memoryMb: spec.memoryMb,
    gpus: spec.gpus,
    wallTimeSec: spec.wallTimeSec,
    workingDir: spec.workingDir,
    envVars: spec.envVars,
    queueName: spec.queueName,
    qos: spec.qos,
    stdinText: spec.stdinText,
    restrictedNoEgress: spec.restrictedNoEgress,
    dataDeliveryCleanup: spec.dataDeliveryCleanup?.map((delivery) => ({ ...delivery })),
    licensedMaterialCleanup: spec.licensedMaterialCleanup?.map((mount) => ({ ...mount })),
  };
}

function expectedOutputToJson(output: ExpectedOutput): Record<string, unknown> {
  return {
    descriptor: output.descriptor,
    path: output.path,
    isBatch: output.isBatch,
    pathsOnly: output.pathsOnly,
    protectedPaths: output.protectedPaths ? [...output.protectedPaths] : undefined,
    protectedMounts: output.protectedMounts?.map(protectedPathMountToJson),
  };
}

function jsonToJobSpec(value: Record<string, unknown>): JobSpec {
  return {
    jobId: requireString(value.jobId, "jobId"),
    name: requireString(value.name, "name"),
    command: requireString(value.command, "command"),
    cpus: requireNumber(value.cpus, "cpus"),
    memoryMb: requireNumber(value.memoryMb, "memoryMb"),
    gpus: requireNumber(value.gpus, "gpus"),
    wallTimeSec: requireNumber(value.wallTimeSec, "wallTimeSec"),
    workingDir: requireString(value.workingDir, "workingDir"),
    envVars: jsonToStringMap(value.envVars),
    queueName: optionalString(value.queueName),
    qos: optionalString(value.qos),
    stdinText: optionalString(value.stdinText),
    restrictedNoEgress: value.restrictedNoEgress === true,
    dataDeliveryCleanup: optionalDataDeliveryCleanup(value.dataDeliveryCleanup),
    licensedMaterialCleanup: optionalLicensedMaterialCleanup(value.licensedMaterialCleanup),
  };
}

function jsonToExpectedOutput(value: Record<string, unknown>): ExpectedOutput {
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
