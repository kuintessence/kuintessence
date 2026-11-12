import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { activeRemoteJobs, type SqliteDb } from "@kuintessence/db";
import { and, asc, eq } from "drizzle-orm";
import {
  type JobSpec,
  type JobStatusResult,
  SchedulerSubmissionUnknownError,
} from "../adapters/base";
import type { ExpectedOutput, ProtectedPathMount } from "../output-collector";

export const PENDING_SCHEDULER_SUBMISSION = "__kq_submission_pending__";

export interface CompletedJobSnapshot {
  format: 1;
  schedulerJobId: string;
  binding: string;
  result: JobStatusResult & { status: "completed" };
}

export interface ActiveRemoteJobRecord {
  submittedAfter?: string;
  completionSnapshot?: CompletedJobSnapshot;
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
    this.assertConfirmedId(input.schedulerJobId);
    if (await this.insert(input)) return;
    const existing = await this.get(input.spec.jobId);
    if (
      !existing ||
      !isDeepStrictEqual(existing.spec, jsonToJobSpec(jobSpecToJson(input.spec))) ||
      !isDeepStrictEqual(
        existing.expectedOutputs,
        input.expectedOutputs.map((output) => jsonToExpectedOutput(expectedOutputToJson(output))),
      )
    )
      throw new SchedulerSubmissionUnknownError(
        "Submitted job conflicts with its durable execution binding",
      );
    if (existing.schedulerJobId === input.schedulerJobId) return;
    if (await this.confirmSubmission(input.spec.jobId, input.schedulerJobId)) return;
    if ((await this.get(input.spec.jobId))?.schedulerJobId !== input.schedulerJobId)
      throw new SchedulerSubmissionUnknownError(
        "Submitted job conflicts with its durable scheduler identity",
      );
  }

  async recordSubmissionIntent(spec: JobSpec, expectedOutputs: ExpectedOutput[]): Promise<void> {
    if (
      !(await this.insert({ spec, expectedOutputs, schedulerJobId: PENDING_SCHEDULER_SUBMISSION }))
    )
      throw new SchedulerSubmissionUnknownError(
        "A durable submission already exists; reconcile it before submitting again",
      );
  }

  private async insert(input: RecordSubmittedInput): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .insert(activeRemoteJobs)
      .values({
        jobId: input.spec.jobId,
        schedulerJobId: input.schedulerJobId,
        spec: jobSpecToJson(input.spec),
        expectedOutputs: input.expectedOutputs.map(expectedOutputToJson),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: activeRemoteJobs.jobId })
      .returning({ jobId: activeRemoteJobs.jobId });
    return rows.length === 1;
  }

  private assertConfirmedId(schedulerJobId: string): void {
    if (
      !schedulerJobId ||
      schedulerJobId === PENDING_SCHEDULER_SUBMISSION ||
      schedulerJobId.includes("\0")
    )
      throw new SchedulerSubmissionUnknownError("A confirmed scheduler identity is required");
  }

  async listActive(): Promise<ActiveRemoteJobRecord[]> {
    const rows = await this.db
      .select()
      .from(activeRemoteJobs)
      .orderBy(asc(activeRemoteJobs.createdAt), asc(activeRemoteJobs.jobId));
    return rows.map(activeRemoteJobFromRow);
  }

  async get(jobId: string): Promise<ActiveRemoteJobRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(activeRemoteJobs)
      .where(eq(activeRemoteJobs.jobId, jobId))
      .limit(1);
    return row ? activeRemoteJobFromRow(row) : undefined;
  }

  async confirmSubmission(jobId: string, schedulerJobId: string): Promise<boolean> {
    this.assertConfirmedId(schedulerJobId);
    const rows = await this.db
      .update(activeRemoteJobs)
      .set({ schedulerJobId, updatedAt: new Date() })
      .where(
        and(
          eq(activeRemoteJobs.jobId, jobId),
          eq(activeRemoteJobs.schedulerJobId, PENDING_SCHEDULER_SUBMISSION),
        ),
      )
      .returning({ jobId: activeRemoteJobs.jobId });
    return rows.length === 1;
  }

  async recordCompleted(input: RecordSubmittedInput, result: JobStatusResult): Promise<void> {
    this.assertConfirmedId(input.schedulerJobId);
    if (input.spec.sandbox || result.status !== "completed")
      throw new Error("Only a real ordinary job completion may be persisted");
    const [row] = await this.db
      .select()
      .from(activeRemoteJobs)
      .where(eq(activeRemoteJobs.jobId, input.spec.jobId))
      .limit(1);
    if (!row || row.schedulerJobId !== input.schedulerJobId)
      throw new Error("Completed job scheduler binding unavailable");
    const existing = activeRemoteJobFromRow(row);
    const binding = completionBinding(input.spec, input.schedulerJobId, input.expectedOutputs);
    if (
      completionBinding(existing.spec, existing.schedulerJobId, existing.expectedOutputs) !==
      binding
    )
      throw new Error("Completed job execution binding changed");
    const snapshot = validateCompletionSnapshot(
      { format: 1, schedulerJobId: input.schedulerJobId, binding, result },
      input.spec,
      input.schedulerJobId,
      input.expectedOutputs,
    );
    if (existing.completionSnapshot) {
      if (!isDeepStrictEqual(existing.completionSnapshot, snapshot))
        throw new Error("Completed job snapshot changed");
      return;
    }
    const rows = await this.db
      .update(activeRemoteJobs)
      .set({ spec: { ...row.spec, completionSnapshot: snapshot }, updatedAt: new Date() })
      .where(
        and(
          eq(activeRemoteJobs.jobId, input.spec.jobId),
          eq(activeRemoteJobs.schedulerJobId, input.schedulerJobId),
          eq(activeRemoteJobs.spec, row.spec),
        ),
      )
      .returning({ jobId: activeRemoteJobs.jobId });
    if (!rows.length) throw new Error("Completed job changed before its durable snapshot");
  }

  async markFinished(jobId: string): Promise<void> {
    await this.db.delete(activeRemoteJobs).where(eq(activeRemoteJobs.jobId, jobId));
  }
}

function activeRemoteJobFromRow(row: typeof activeRemoteJobs.$inferSelect): ActiveRemoteJobRecord {
  if (row.spec.completionSnapshot !== undefined && row.spec.sandbox !== undefined)
    throw new Error("Sandbox completion snapshots are unsupported");
  const spec = jsonToJobSpec(row.spec);
  if (spec.jobId !== row.jobId) throw new Error("Active job identity binding changed");
  const expectedOutputs = row.expectedOutputs.map(jsonToExpectedOutput);
  const completionSnapshot =
    row.spec.completionSnapshot === undefined
      ? undefined
      : validateCompletionSnapshot(
          row.spec.completionSnapshot,
          spec,
          row.schedulerJobId,
          expectedOutputs,
        );
  return {
    jobId: row.jobId,
    submittedAfter: new Date(row.createdAt.getTime() - 86400000).toISOString().slice(0, 10),
    schedulerJobId: row.schedulerJobId,
    spec,
    expectedOutputs,
    completionSnapshot,
  };
}

function completionBinding(
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
    spec.sandbox ||
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
      (key) => !["status", "exitCode", "message", "node", "reason", "startedAt"].includes(key),
    )
  )
    throw new Error("Invalid completed job result");
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
    },
  };
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
    queueTargetMode: spec.queueTargetMode,
    queueValidationMode: spec.queueValidationMode,
    queueName: spec.queueName,
    schedulerName: spec.schedulerName,
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
    queueTargetMode: optionalQueueTargetMode(value.queueTargetMode),
    queueValidationMode: optionalQueueValidationMode(value.queueValidationMode),
    schedulerName: optionalString(value.schedulerName),
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

function optionalQueueTargetMode(value: unknown): JobSpec["queueTargetMode"] {
  if (value === undefined || value === "default" || value === "named") return value;
  throw new Error("Invalid durable queue target mode");
}
function optionalQueueValidationMode(value: unknown): JobSpec["queueValidationMode"] {
  if (value === undefined || value === "off" || value === "shadow" || value === "enforce")
    return value;
  throw new Error("Invalid durable queue validation mode");
}
