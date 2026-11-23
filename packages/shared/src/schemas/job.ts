import { z } from "zod";
import { DataInputRefSchema, DataRequirementsSchema } from "../data-market";

export const EnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name");

export const JobSchedulerLimitsSchema = z.strictObject({
  nodeCount: z.number().int().positive().max(2_147_483_647).optional(),
  maxCpuTime: z.number().int().positive().max(2_147_483_647).optional(),
  stopTime: z.number().int().positive().max(253402300799).optional(),
});
export type JobSchedulerLimits = z.infer<typeof JobSchedulerLimitsSchema>;

export const ResourceRequestSchema = z.object({
  cpus: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  gpus: z.number().int().nonnegative().optional(),
  wallTimeSec: z.number().int().positive().optional(),
  schedulerLimits: JobSchedulerLimitsSchema.optional(),
});

/** CPU, memory and GPU requests are job totals; native multi-node chunks must fit exactly. */
export function schedulerLimitRejection(
  scheduler: string,
  resources: {
    cpus: number;
    memoryMb: number;
    gpus?: number;
    wallTimeSec?: number;
    schedulerLimits?: JobSchedulerLimits;
  },
): string | undefined {
  const limits = resources.schedulerLimits;
  if (!limits) return;
  const nodes = limits.nodeCount ?? 1;
  if (nodes > 1) {
    if (!["slurm", "pbs-pro", "torque"].includes(scheduler))
      return "Multi-node allocations require an HPC scheduler";
    if (resources.cpus % nodes || resources.memoryMb % nodes || (resources.gpus ?? 0) % nodes)
      return "Job CPU, memory and GPU totals must divide evenly across nodes";
  }
  if (limits.maxCpuTime !== undefined && scheduler !== "pbs-pro" && scheduler !== "torque")
    return "Aggregate CPU time limits require PBS Pro or Torque";
  if (limits.stopTime !== undefined) {
    if (limits.stopTime <= Math.floor(Date.now() / 1000)) return "Job stop time has passed";
    if (scheduler !== "slurm" || !resources.wallTimeSec)
      return "An absolute deadline requires Slurm and a wall time";
  }
}

export const SoftwareReqSchema = z
  .object({
    siteRuntimeRevisionId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    spec: z.string().min(1).max(500).optional(),
    name: z.string().min(1),
    version: z.string().optional(),
    /** If true, user is requesting that this software be installed on the agent. */
    installable: z.boolean().optional().default(false),
  })
  .refine(
    (req) => !req.siteRuntimeRevisionId || (!!req.assetId && !!req.version && !req.installable),
    "Site runtime revisions require a preinstalled, versioned software asset",
  );

export const JobUsecaseFileValueSchema = z.object({
  fileMetadataId: z.string().min(1),
  fileMetadataName: z.string().min(1),
});

export const JobUsecaseInputValueSchema = z.union([
  z.string(),
  JobUsecaseFileValueSchema,
  z.array(JobUsecaseFileValueSchema),
]);

export const JobUsecaseInputsSchema = z.record(z.string(), JobUsecaseInputValueSchema);
export const JobDataInputsSchema = z.record(z.string(), DataInputRefSchema);

/**
 * A staged-input path relative to a job's run directory. It is interpolated
 * into the agent's container file ops and used as a download target written as
 * root, so it must not escape the run dir via `..` nor carry control characters
 * (the agent enforces the `..` rule too — defense in depth; see tbd #12).
 * Absolute paths and spaces are allowed (a leading `/` does not escape the
 * `<base>/<stagePath>` join, and filenames legitimately contain spaces).
 */
export const StagePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.split("/").some((seg) => seg === ".."), {
    message: "stagePath must not contain '..' path segments",
  })
  .refine((p) => ![...p].some((c) => c.charCodeAt(0) < 0x20), {
    message: "stagePath must not contain control characters",
  });

/** A selector-only request for bytes that remain on the selected Agent. */
export const LicensedMaterialRequestSchema = z.object({
  selector: z.string().min(1).max(255),
  /** Legacy display metadata. Dispatch always uses the subject stored in the
   * provider-owned material mapping, never this caller-supplied value. */
  licenseSubject: z.string().min(1).max(255).optional(),
  targetPath: StagePathSchema,
  requiredElements: z.array(z.string().min(1).max(8)).default([]),
});
export type LicensedMaterialRequest = z.infer<typeof LicensedMaterialRequestSchema>;

export const JobSubmitSchema = z.object({
  name: z.string().min(1).max(255),
  command: z.string().min(1),
  resources: ResourceRequestSchema,
  schedulingStrategy: z
    .object({
      queueId: z.string().min(1).max(255).optional(),
      preferredQueueIds: z.array(z.string().min(1).max(255)).optional(),
    })
    .optional(),
  workingDir: z.string().optional(),
  envVars: z.record(EnvironmentNameSchema, z.string()).optional(),
  tags: z.array(z.string()).optional(),
  softwareRequirements: z.array(SoftwareReqSchema).optional(),
  usecasePackageId: z.string().uuid().optional(),
  usecasePackageName: z.string().min(1).max(255).optional(),
  usecasePackageVersion: z.string().min(1).max(50).optional(),
  usecaseInputs: JobUsecaseInputsSchema.optional(),
  dataInputs: JobDataInputsSchema.optional(),
  dataRequirements: z.record(z.string(), DataRequirementsSchema).optional(),
  /**
   * Workflow-runtime-supplied app template key. Stored on
   * `jobs.app_template_key` so CP-Console "top apps" can group without
   * joining `metering_usage_raw`.
   */
  appTemplateKey: z.string().min(1).max(255).optional(),
  /**
   * Usecase materialization. Files the agent stages from MinIO into
   * the run dir before execution, and outputs it surfaces afterward. Carried
   * through to DispatchJob.
   */
  inputStaging: z
    .array(
      z.object({
        fileMetadataId: z.string(),
        stagePath: StagePathSchema,
        /** Presigned MinIO GET URL the agent fetches from (filled just before dispatch). */
        sourceUrl: z.string().optional(),
      }),
    )
    .optional(),
  expectedOutputs: z
    .array(
      z.object({
        descriptor: z.string(),
        path: z.string(),
        isBatch: z.boolean(),
        pathsOnly: z.boolean().optional(),
      }),
    )
    .optional(),
  fileOutputDescriptors: z.array(z.string().min(1)).optional(),
  stdinText: z.string().optional(),
  licensedMaterials: z.array(LicensedMaterialRequestSchema).optional(),
  /**
   * Placement hints. `locality.dataSites` lists site IDs that already hold the
   * job's input data; the locality scorer prefers co-located agents. Resource
   * sizing stays in `resources` — this block is hints only.
   */
  requires: z
    .object({
      locality: z.object({ dataSites: z.array(z.string()).optional() }).optional(),
    })
    .optional(),
});

export const JobUsecaseSubmitSchema = z.object({
  name: z.string().min(1).max(255),
  usecasePackageId: z.string().uuid(),
  inputs: JobUsecaseInputsSchema.default({}),
  dataInputs: JobDataInputsSchema.optional(),
  dataRequirements: z.record(z.string(), DataRequirementsSchema).optional(),
  resources: ResourceRequestSchema,
  schedulingStrategy: z
    .object({
      queueId: z.string().min(1).max(255).optional(),
      preferredQueueIds: z.array(z.string().min(1).max(255)).optional(),
    })
    .optional(),
  workingDir: z.string().optional(),
  tags: z.array(z.string()).optional(),
  installMissingSoftware: z.boolean().optional().default(false),
});

export type JobSubmit = z.infer<typeof JobSubmitSchema>;
export type JobUsecaseSubmit = z.infer<typeof JobUsecaseSubmitSchema>;
export type JobUsecaseFileValue = z.infer<typeof JobUsecaseFileValueSchema>;
export type JobUsecaseInputValue = z.infer<typeof JobUsecaseInputValueSchema>;
export type JobUsecaseInputs = z.infer<typeof JobUsecaseInputsSchema>;
export type JobDataInputs = z.infer<typeof JobDataInputsSchema>;
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;
export type SoftwareReq = z.infer<typeof SoftwareReqSchema>;
