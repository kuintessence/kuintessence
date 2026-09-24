import { create } from "@bufbuild/protobuf";
import { jobCancellations, jobWorkRootReleases, type PgDb } from "@kuintessence/db";
import {
  CancelJobSchema,
  DataDeliveryBindingSchema,
  DataDeliveryEntrySchema,
  DataDeliveryMethod,
  DataDeliveryRevokeSchema,
  DataScanRequestSchema,
  DispatchJobSchema,
  FileTransferCancelSchema,
  FileTransferRequestSchema,
  InputStagingSchema,
  JobLogsRequestSchema,
  LicensedMaterialMountSchema,
  PartUrlSchema,
  PartUrlsResponseSchema,
  QueueTargetMode as ProtoQueueTargetMode,
  QueueValidationMode as ProtoQueueValidationMode,
  ReleaseJobWorkRootSchema,
  SandboxArtifactMountSchema,
  SandboxArtifactReleaseItemSchema,
  SandboxArtifactReleaseSchema,
  SandboxBatchEntrySchema,
  SandboxExecutionIdentitySchema,
  SandboxExecutionSchema,
  SandboxIdentityMode,
  SandboxIoType,
  SandboxKubernetesAccountSchema,
  SandboxLanguage,
  SandboxMountMode,
  SandboxResourceLimitsSchema,
  SandboxRuntimeKind,
  SandboxRuntimeRefSchema,
  SandboxScriptBundleSchema,
  SandboxSignatureEnvelopeSchema,
  SandboxUnixAccountSchema,
  type ServerMessage,
  ServerMessageSchema,
  ShellExecRequestSchema,
  type SoftwareOperationAction,
  SoftwareOperationRequestSchema,
  SpackJobExecutionSchema,
} from "@kuintessence/proto";
import type {
  JobSubmit,
  QueueTargetMode,
  QueueValidationMode,
  SandboxSignedManifest,
  SpackExecution,
} from "@kuintessence/shared";
import { createLogger } from "@kuintessence/shared";
import { and, asc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import type { ResolvedDataDelivery } from "../services/data-delivery";

const logger = createLogger("dispatcher");

function sandboxLanguage(value: SandboxSignedManifest["script"]["language"]): SandboxLanguage {
  if (value === "python") return SandboxLanguage.PYTHON;
  if (value === "nodejs") return SandboxLanguage.NODEJS;
  return SandboxLanguage.BASH;
}

function queueTargetModeToProto(value: QueueTargetMode | undefined): ProtoQueueTargetMode {
  if (value === "default") return ProtoQueueTargetMode.DEFAULT;
  if (value === "named") return ProtoQueueTargetMode.NAMED;
  return ProtoQueueTargetMode.UNSPECIFIED;
}

function queueValidationModeToProto(
  value: QueueValidationMode | undefined,
): ProtoQueueValidationMode {
  if (value === "off") return ProtoQueueValidationMode.OFF;
  if (value === "shadow") return ProtoQueueValidationMode.SHADOW;
  if (value === "enforce") return ProtoQueueValidationMode.ENFORCE;
  return ProtoQueueValidationMode.UNSPECIFIED;
}

function sandboxIoType(value: SandboxSignedManifest["mounts"][number]["ioType"]): SandboxIoType {
  if (value === "Text") return SandboxIoType.TEXT;
  if (value === "JSON") return SandboxIoType.JSON;
  if (value === "File") return SandboxIoType.FILE;
  return SandboxIoType.FILE_BATCH;
}

function sandboxExecutionToProto(manifest: SandboxSignedManifest) {
  const identity = manifest.identity;
  return create(SandboxExecutionSchema, {
    script: create(SandboxScriptBundleSchema, {
      language: sandboxLanguage(manifest.script.language),
      entrypoint: manifest.script.entrypoint,
      content: Buffer.from(manifest.script.contentBase64, "base64"),
      sha256: manifest.script.sha256,
      bundleSha256: manifest.script.bundleSha256,
    }),
    runtime: create(SandboxRuntimeRefSchema, {
      profileId: manifest.runtime.profileId,
      kind: manifest.runtime.kind === "OCI" ? SandboxRuntimeKind.OCI : SandboxRuntimeKind.SIF,
      digest: manifest.runtime.digest,
    }),
    executionMode: manifest.executionMode,
    runtimeAttestationId: manifest.runtimeAttestationId ?? "",
    ...(manifest.executionProfile
      ? {
          executionProfile: manifest.executionProfile,
        }
      : {}),
    executionIdentity: create(SandboxExecutionIdentitySchema, {
      mode:
        identity.mode === "SharedService"
          ? SandboxIdentityMode.SHARED_SERVICE
          : SandboxIdentityMode.MAPPED_ACCOUNT,
      accountId: identity.accountId,
      backend:
        identity.backend === "Unix"
          ? {
              case: "unix",
              value: create(SandboxUnixAccountSchema, {
                username: identity.username,
                uid: identity.uid,
                gid: identity.gid,
                schedulerAccount: identity.schedulerAccount ?? "",
                allowedQueues: identity.allowedQueues,
              }),
            }
          : {
              case: "kubernetes",
              value: create(SandboxKubernetesAccountSchema, {
                namespace: identity.namespace,
                serviceAccount: identity.serviceAccount,
                quotaPolicy: identity.quotaPolicy ?? "",
              }),
            },
    }),
    artifactMounts: manifest.mounts.map((mount) =>
      create(SandboxArtifactMountSchema, {
        descriptor: mount.descriptor,
        ioType: sandboxIoType(mount.ioType),
        mode: mount.mode === "ReadOnly" ? SandboxMountMode.READ_ONLY : SandboxMountMode.WRITE_ONLY,
        relativePath: mount.relativePath,
        containerPath: mount.containerPath,
        expectedSha256: mount.expectedSha256 ?? "",
        sizeLimitBytes: BigInt(mount.sizeLimitBytes),
        required: mount.required,
        inlineContent: mount.inlineContentBase64
          ? Buffer.from(mount.inlineContentBase64, "base64")
          : new Uint8Array(),
        batchEntries: mount.batchEntries.map((entry) =>
          create(SandboxBatchEntrySchema, {
            relativePath: entry.relativePath,
            sha256: entry.sha256,
            sizeBytes: BigInt(entry.sizeBytes),
          }),
        ),
      }),
    ),
    limits: create(SandboxResourceLimitsSchema, {
      pids: manifest.limits.pids,
      outputBytes: BigInt(manifest.limits.outputBytes),
      logBytes: BigInt(manifest.limits.logBytes),
    }),
    envelope: create(SandboxSignatureEnvelopeSchema, {
      keyId: manifest.envelope.keyId,
      nonce: manifest.envelope.nonce,
      issuedAtUnixMs: BigInt(manifest.envelope.issuedAtUnixMs),
      expiresAtUnixMs: BigInt(manifest.envelope.expiresAtUnixMs),
      manifestSha256: manifest.envelope.manifestSha256,
      signature: Buffer.from(manifest.envelope.signatureBase64, "base64"),
    }),
    networkDisabled: manifest.networkDisabled,
  });
}

export interface AgentChannel {
  push(msg: ServerMessage): void;
  close(): void;
  spackMaterialDeliveryV1?: boolean;
  verifiedCertFingerprint?: string;
}

/**
 * Tracks active connectRPC streams keyed by agent ID. Each stream's outbound
 * generator (in agent-handler.ts) registers itself by calling `register`, and
 * deregisters on disconnect via `unregister`.
 *
 * The dispatcher exposes pushDispatchJob/pushCancelJob to send messages to a
 * specific agent without the caller needing to know about the underlying stream.
 */
export class AgentDispatcher {
  private channels = new Map<string, AgentChannel>();

  register(agentId: string, channel: AgentChannel): void {
    const existing = this.channels.get(agentId);
    if (existing) {
      logger.warn({ agentId }, "Replacing existing channel for agent");
      existing.close();
    }
    this.channels.set(agentId, channel);
    logger.info({ agentId }, "Agent channel registered");
  }

  unregister(agentId: string, channel?: AgentChannel): void {
    if (channel && this.channels.get(agentId) !== channel) {
      logger.debug({ agentId }, "Ignoring stale agent channel unregister");
      return;
    }
    this.channels.delete(agentId);
    logger.info({ agentId }, "Agent channel unregistered");
  }

  isOnline(agentId: string): boolean {
    return this.channels.has(agentId);
  }

  isCurrentChannel(agentId: string, channel: AgentChannel): boolean {
    return this.channels.get(agentId) === channel;
  }

  /**
   * Read-only accessor for the per-agent channel so
   * the software-governance PolicyPusher can push ServerMessage payloads
   * without having to copy the dispatch encoding logic. Returns undefined
   * when the agent is offline; callers MUST handle that case.
   */
  getChannel(agentId: string): AgentChannel | undefined {
    return this.channels.get(agentId);
  }

  /**
   * Read-only accessor for currently-online agent IDs. Used by the
   * software-governance push path to fan out to all online agents
   * without exposing the channels map.
   */
  onlineAgentIds(): string[] {
    return Array.from(this.channels.keys());
  }

  private pushToAgent(agentId: string, msg: ServerMessage): boolean {
    const ch = this.channels.get(agentId);
    if (!ch) return false;
    try {
      ch.push(msg);
      return true;
    } catch (err) {
      this.channels.delete(agentId);
      logger.warn({ agentId, err }, "Agent channel push failed; channel removed");
      return false;
    }
  }

  /**
   * Push a DispatchJob message to the given agent. Returns true if queued,
   * false if the agent is not currently connected.
   */
  pushDispatchJob(
    agentId: string,
    jobId: string,
    job: JobSubmit & {
      jobIdInternal: string;
      dispatchEpoch?: number;
      queueName?: string;
      queueTargetMode?: QueueTargetMode;
      queueValidationMode?: QueueValidationMode;
      qos?: string | null;
      sandboxExecution?: SandboxSignedManifest;
      spackExecution?: SpackExecution;
      licensedMaterialMounts?: Array<{
        selector: string;
        targetPath: string;
        expectedFingerprint: string;
        requiredElements: string[];
      }>;
      restrictedNoEgress?: boolean;
      inputStaging?: Array<{
        fileMetadataId: string;
        stagePath: string;
        sourceUrl?: string;
        deliveryLeaseId?: string;
        deliveryLeaseExpiresAtUnixMs?: number;
      }>;
      dataDeliveries?: ResolvedDataDelivery[];
    },
  ): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "dispatchJob",
        value: create(DispatchJobSchema, {
          jobId,
          name: job.name,
          command: job.command,
          cpus: job.resources.cpus,
          memoryMb: BigInt(job.resources.memoryMb),
          gpus: job.resources.gpus ?? 0,
          wallTimeSec: BigInt(job.resources.wallTimeSec ?? 0),
          workingDir: job.workingDir ?? "",
          envVars: job.envVars ?? {},
          inputStaging: (job.inputStaging ?? []).map((input) => {
            const staged = input as typeof input & {
              deliveryLeaseId?: string;
              deliveryLeaseExpiresAtUnixMs?: number;
            };
            return create(InputStagingSchema, {
              fileMetadataId: staged.fileMetadataId,
              stagePath: staged.stagePath,
              sourceUrl: staged.sourceUrl ?? "",
              deliveryLeaseId: staged.deliveryLeaseId ?? "",
              deliveryLeaseExpiresAtUnixMs: BigInt(staged.deliveryLeaseExpiresAtUnixMs ?? 0),
            });
          }),
          expectedOutputs: (job.expectedOutputs ?? []).map((output) => ({
            ...output,
            pathsOnly: output.pathsOnly ?? false,
          })),
          fileOutputDescriptors: job.fileOutputDescriptors ?? [],
          queueName: job.queueName ?? "",
          queueTargetMode: queueTargetModeToProto(job.queueTargetMode),
          queueValidationMode: queueValidationModeToProto(job.queueValidationMode),
          qos: job.qos ?? "",
          stdinText: job.stdinText ?? "",
          sandboxExecution: job.sandboxExecution
            ? sandboxExecutionToProto(job.sandboxExecution)
            : undefined,
          spackExecution: job.spackExecution
            ? create(SpackJobExecutionSchema, job.spackExecution)
            : undefined,
          licensedMaterialMounts: (job.licensedMaterialMounts ?? []).map((mount) =>
            create(LicensedMaterialMountSchema, mount),
          ),
          restrictedNoEgress: job.restrictedNoEgress ?? false,
          dataDeliveries: (job.dataDeliveries ?? []).map((delivery) =>
            create(DataDeliveryBindingSchema, {
              bindingId: delivery.bindingId,
              locationId: delivery.locationId,
              assetId: delivery.assetId,
              versionId: delivery.versionId,
              manifestDigest: delivery.manifestDigest,
              selectedEntries: delivery.selectedEntries.map((entry) =>
                create(DataDeliveryEntrySchema, {
                  path: entry.path,
                  sha256: entry.sha256,
                  sizeBytes: BigInt(entry.sizeBytes),
                  objectDownloadUrl: entry.objectDownloadUrl ?? "",
                }),
              ),
              stagePath: delivery.stagePath,
              method: dataDeliveryMethodToProto(delivery.method),
              managedRootId: delivery.managedRootId ?? "",
              relativePath: delivery.relativePath ?? "",
              restricted: delivery.restricted,
              leaseId: delivery.leaseId,
              leaseExpiresAtUnixMs: BigInt(delivery.leaseExpiresAtUnixMs),
            }),
          ),
          dispatchEpoch: BigInt(job.dispatchEpoch ?? 0),
        }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  /**
   * Push a CancelJob message to the given agent. Returns true if queued,
   * false if the agent is not currently connected.
   */
  pushCancelJob(agentId: string, jobId: string, revokedEpoch = 0): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "cancelJob",
        value: create(CancelJobSchema, { jobId, revokedEpoch: BigInt(revokedEpoch) }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushDataDeliveryRevoke(
    agentId: string,
    jobId: string,
    reasonCode: string,
    destroyRestrictedWorkRoot: boolean,
    revokedEpoch = 0,
  ): boolean {
    return this.pushToAgent(
      agentId,
      create(ServerMessageSchema, {
        payload: {
          case: "dataDeliveryRevoke",
          value: create(DataDeliveryRevokeSchema, {
            jobId,
            reasonCode,
            destroyRestrictedWorkRoot,
            revokedEpoch: BigInt(revokedEpoch),
          }),
        },
      }),
    );
  }

  pushDataScanRequest(
    agentId: string,
    request: {
      requestId: string;
      importId: string;
      assetId: string;
      versionId: string;
      managedRootId: string;
      relativePath: string;
      providerOrgId: string;
    },
  ): boolean {
    return this.pushToAgent(
      agentId,
      create(ServerMessageSchema, {
        payload: {
          case: "dataScanRequest",
          value: create(DataScanRequestSchema, request),
        },
      }),
    );
  }

  pushSandboxArtifactRelease(
    agentId: string,
    requestId: string,
    items: Array<{ replicaId: string; storageRef: string }>,
  ): boolean {
    return this.pushToAgent(
      agentId,
      create(ServerMessageSchema, {
        payload: {
          case: "sandboxArtifactRelease",
          value: create(SandboxArtifactReleaseSchema, {
            requestId,
            items: items.map((item) => create(SandboxArtifactReleaseItemSchema, item)),
          }),
        },
      }),
    );
  }

  pushShellExec(agentId: string, requestId: string, input: string, timeoutSec: number): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "shellExecRequest",
        value: create(ShellExecRequestSchema, { requestId, input, timeoutSec }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushJobLogsRequest(
    agentId: string,
    requestId: string,
    schedulerJobId: string,
    lines: number,
    jobId: string,
    restrictedNoEgress: boolean,
  ): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "jobLogsRequest",
        value: create(JobLogsRequestSchema, {
          requestId,
          schedulerJobId,
          lines,
          jobId,
          restrictedNoEgress,
        }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushFileTransfer(
    agentId: string,
    requestId: string,
    payload: {
      direction: "cloud_to_cluster" | "cluster_to_cloud";
      sourceUrl?: string;
      sourcePath?: string;
      targetUrl?: string;
      targetPath?: string;
      totalBytes: number;
      /** Multipart cluster_to_cloud: the Server-pre-initiated upload id. */
      uploadId?: string;
      /** Multipart cluster_to_cloud: the Server-signed multipart commit token. */
      commitToken?: string;
      /** Multipart cluster_to_cloud: part size in bytes (converted to bigint on the wire). */
      partSize?: number;
    },
  ): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "fileTransferRequest",
        value: create(FileTransferRequestSchema, {
          requestId,
          direction: payload.direction,
          sourceUrl: payload.sourceUrl ?? "",
          sourcePath: payload.sourcePath ?? "",
          targetUrl: payload.targetUrl ?? "",
          targetPath: payload.targetPath ?? "",
          totalBytes: BigInt(payload.totalBytes),
          uploadId: payload.uploadId ?? "",
          commitToken: payload.commitToken ?? "",
          partSize: BigInt(payload.partSize ?? 0),
        }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushFileTransferCancel(agentId: string, requestId: string): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "fileTransferCancel",
        value: create(FileTransferCancelSchema, { requestId }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushReleaseJobWorkRoot(agentId: string, jobId: string): boolean {
    return this.pushToAgent(
      agentId,
      create(ServerMessageSchema, {
        payload: {
          case: "releaseJobWorkRoot",
          value: create(ReleaseJobWorkRootSchema, { jobId }),
        },
      }),
    );
  }

  /**
   * Push the presigned multipart part URLs the agent requested back to it,
   * correlated by `requestId`. Returns true if queued, false if the agent
   * is not currently connected.
   */
  pushPartUrlsResponse(
    agentId: string,
    requestId: string,
    urls: { partNumber: number; url: string }[],
  ): boolean {
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "partUrlsResponse",
        value: create(PartUrlsResponseSchema, {
          requestId,
          urls: urls.map((u) => create(PartUrlSchema, { partNumber: u.partNumber, url: u.url })),
        }),
      },
    });
    return this.pushToAgent(agentId, msg);
  }

  pushSoftwareOperation(
    agentId: string,
    payload: {
      operationId: string;
      action: SoftwareOperationAction;
      spec: string;
      requestedBy: string;
      spackMaterialTicket?: string;
      spackManifestDigest?: string;
    },
  ): boolean {
    if (payload.spackMaterialTicket) {
      const channel = this.channels.get(agentId);
      if (!channel?.spackMaterialDeliveryV1 || !channel.verifiedCertFingerprint) return false;
    }
    const msg = create(ServerMessageSchema, {
      payload: {
        case: "softwareOperationRequest",
        value: create(SoftwareOperationRequestSchema, payload),
      },
    });
    return this.pushToAgent(agentId, msg);
  }
}

interface CancellationWaiter {
  revokedEpoch: number;
  resolve: () => void;
}

/**
 * Durable Server→Agent cancellation delivery. The pending record is independent
 * of an Agent stream, so a disconnected Agent receives the same cancellation
 * after it registers again.
 */
export class JobCancellationOutbox {
  private readonly waiters = new Map<string, Set<CancellationWaiter>>();

  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: Pick<AgentDispatcher, "pushCancelJob">,
  ) {}

  async enqueue(agentId: string, jobId: string, revokedEpoch: number): Promise<void> {
    assertCancellationEpoch(revokedEpoch);
    const inserted = await this.db
      .insert(jobCancellations)
      .values({ agentId, jobId, revokedEpoch })
      .onConflictDoNothing({ target: jobCancellations.jobId })
      .returning({ jobId: jobCancellations.jobId });
    if (inserted.length > 0) return;

    // A later epoch supersedes an earlier acknowledgement. The Agent binding
    // remains immutable after the cancellation intent is first recorded.
    await this.db
      .update(jobCancellations)
      .set({ revokedEpoch, acknowledgedAt: null })
      .where(
        and(eq(jobCancellations.jobId, jobId), lt(jobCancellations.revokedEpoch, revokedEpoch)),
      );
  }

  async redeliver(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ jobId: jobCancellations.jobId, revokedEpoch: jobCancellations.revokedEpoch })
      .from(jobCancellations)
      .where(and(eq(jobCancellations.agentId, agentId), isNull(jobCancellations.acknowledgedAt)))
      .orderBy(asc(jobCancellations.createdAt), asc(jobCancellations.id));
    for (const row of rows) {
      this.dispatcher.pushCancelJob(agentId, row.jobId, row.revokedEpoch);
    }
    return rows.length;
  }

  async acknowledge(agentId: string, jobId: string, revokedEpoch: number): Promise<boolean> {
    assertCancellationEpoch(revokedEpoch);
    const [updated] = await this.db
      .update(jobCancellations)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          eq(jobCancellations.agentId, agentId),
          eq(jobCancellations.jobId, jobId),
          eq(jobCancellations.revokedEpoch, revokedEpoch),
          isNull(jobCancellations.acknowledgedAt),
        ),
      )
      .returning({ revokedEpoch: jobCancellations.revokedEpoch });
    if (updated) {
      this.resolveWaiters(jobId, updated.revokedEpoch);
      return true;
    }

    const [existing] = await this.db
      .select({ revokedEpoch: jobCancellations.revokedEpoch })
      .from(jobCancellations)
      .where(
        and(
          eq(jobCancellations.agentId, agentId),
          eq(jobCancellations.jobId, jobId),
          eq(jobCancellations.revokedEpoch, revokedEpoch),
          isNotNull(jobCancellations.acknowledgedAt),
        ),
      )
      .limit(1);
    if (!existing) return false;
    this.resolveWaiters(jobId, existing.revokedEpoch);
    return true;
  }

  async waitForAcknowledgement(jobId: string, revokedEpoch: number): Promise<void> {
    assertCancellationEpoch(revokedEpoch);
    const waiter = this.addWaiter(jobId, revokedEpoch);
    try {
      const [acknowledged] = await this.db
        .select({ revokedEpoch: jobCancellations.revokedEpoch })
        .from(jobCancellations)
        .where(
          and(
            eq(jobCancellations.jobId, jobId),
            gte(jobCancellations.revokedEpoch, revokedEpoch),
            isNotNull(jobCancellations.acknowledgedAt),
          ),
        )
        .limit(1);
      if (acknowledged) return;
      await waiter.promise;
    } finally {
      this.removeWaiter(jobId, waiter.entry);
    }
  }

  private addWaiter(
    jobId: string,
    revokedEpoch: number,
  ): { entry: CancellationWaiter; promise: Promise<void> } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const entry = { revokedEpoch, resolve };
    const waiters = this.waiters.get(jobId) ?? new Set<CancellationWaiter>();
    waiters.add(entry);
    this.waiters.set(jobId, waiters);
    return { entry, promise };
  }

  private removeWaiter(jobId: string, entry: CancellationWaiter): void {
    const waiters = this.waiters.get(jobId);
    if (!waiters) return;
    waiters.delete(entry);
    if (waiters.size === 0) this.waiters.delete(jobId);
  }

  private resolveWaiters(jobId: string, revokedEpoch: number): void {
    const waiters = this.waiters.get(jobId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.revokedEpoch <= revokedEpoch) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (waiters.size === 0) this.waiters.delete(jobId);
  }
}

export class JobWorkRootReleaseOutbox {
  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: Pick<AgentDispatcher, "pushReleaseJobWorkRoot">,
  ) {}

  async enqueue(agentId: string, jobId: string): Promise<void> {
    await this.db
      .insert(jobWorkRootReleases)
      .values({ agentId, jobId })
      .onConflictDoNothing({ target: jobWorkRootReleases.jobId });
  }

  async redeliver(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ jobId: jobWorkRootReleases.jobId })
      .from(jobWorkRootReleases)
      .where(
        and(eq(jobWorkRootReleases.agentId, agentId), isNull(jobWorkRootReleases.acknowledgedAt)),
      )
      .orderBy(asc(jobWorkRootReleases.createdAt), asc(jobWorkRootReleases.jobId));
    for (const row of rows) {
      this.dispatcher.pushReleaseJobWorkRoot(agentId, row.jobId);
    }
    return rows.length;
  }

  async acknowledge(agentId: string, jobId: string): Promise<boolean> {
    const [updated] = await this.db
      .update(jobWorkRootReleases)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          eq(jobWorkRootReleases.agentId, agentId),
          eq(jobWorkRootReleases.jobId, jobId),
          isNull(jobWorkRootReleases.acknowledgedAt),
        ),
      )
      .returning({ jobId: jobWorkRootReleases.jobId });
    if (updated) return true;

    const [existing] = await this.db
      .select({ jobId: jobWorkRootReleases.jobId })
      .from(jobWorkRootReleases)
      .where(
        and(
          eq(jobWorkRootReleases.agentId, agentId),
          eq(jobWorkRootReleases.jobId, jobId),
          isNotNull(jobWorkRootReleases.acknowledgedAt),
        ),
      )
      .limit(1);
    return existing !== undefined;
  }
}

function assertCancellationEpoch(revokedEpoch: number): void {
  if (!Number.isSafeInteger(revokedEpoch) || revokedEpoch < 0) {
    throw new Error("Cancellation revoked epoch must be a non-negative safe integer");
  }
}

function dataDeliveryMethodToProto(method: ResolvedDataDelivery["method"]): DataDeliveryMethod {
  switch (method) {
    case "object-download":
      return DataDeliveryMethod.OBJECT_DOWNLOAD;
    case "stage-copy":
      return DataDeliveryMethod.STAGE_COPY;
    case "readonly-mount":
      return DataDeliveryMethod.READONLY_MOUNT;
  }
}
