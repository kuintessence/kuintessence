import { readFile } from "node:fs/promises";
import { createSecureServer, createServer } from "node:http2";
import { posix as posixPath } from "node:path";
import {
  createPgDb,
  type PgDb,
  SpackMaterialReferences,
  userOrgMemberships,
  users,
  workflowTemplates,
} from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  type JobSubmission,
  type RoleName,
  usecase,
  WorkflowExecutionInterrupted,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { cors } from "hono/cors";
import { ensureCa } from "./auth/ca";
import { createCertIssuanceService } from "./auth/cert-service";
import { createAgentProviderOrgResolver } from "./auth/ownership";
import { createPgAgentCertLookup, createPgCertStore } from "./auth/pg-cert-store";
import { makePgSshRowLoader } from "./auth/ssh-credential-store";
import { makeVaultResolver } from "./auth/ssh-credential-vault";
import { insertRecordingRow, sweepOldRecordings } from "./auth/ssh-recording-store";
import { bootstrapSsoConfig } from "./auth/sso-bootstrap";
import {
  parseTrustedProxyCidrs,
  RESOLVED_CLIENT_IP_HEADER,
  resolveHttpClientIp,
} from "./auth/trusted-proxy";
import {
  jobProviderTuple,
  jobSubmissionTuples,
  sshSessionAgentTuple,
  sshSessionOpenerTuple,
  sshSessionPlatformTuple,
} from "./authz/projection";
import { AuthzService, type AuthzTuple } from "./authz/service";
import { loadServerConfig } from "./config";
import { EventBus } from "./events/event-bus";
import { FederationAccountingCollection } from "./federation/accounting-collection";
import { FederationAgreementService } from "./federation/agreements";
import { FederationAssetService } from "./federation/assets";
import { FederationAttestationService } from "./federation/attestation";
import { UnixAttestationClient } from "./federation/attestation-client";
import { FederationAttestationWorker } from "./federation/attestation-worker";
import { FederationCancellationMonitor } from "./federation/cancellation-monitor";
import { FederationCommercialAgreementService } from "./federation/commercial-agreements";
import { UnixCommercialClient } from "./federation/commercial-client";
import { FederationCommercialExecutionService } from "./federation/commercial-execution";
import { FederationCommercialSubmissionService } from "./federation/commercial-submissions";
import { FederationCommercialWorker } from "./federation/commercial-worker";
import { FederationDataDispatch } from "./federation/data-dispatch";
import { createFederationDatasetPreflight } from "./federation/dataset-preflight";
import { FederationDispatchAuthorization } from "./federation/dispatch-authorization";
import {
  FederationExecutionBindingService,
  loadFederationWorkflowBinding,
  queueFederationWorkflow,
} from "./federation/execution-binding";
import { FederationExecutionMonitor } from "./federation/execution-monitor";
import { FederationInputImports } from "./federation/input-imports";
import { FederationInputPublication } from "./federation/input-publication";
import { FederationInputReader } from "./federation/input-reader";
import {
  FederationInputStorage,
  type FederationInputStorageBackend,
} from "./federation/input-storage";
import { FederationInputTransfers } from "./federation/input-transfers";
import { FederationInputTransport } from "./federation/input-transport";
import { FederationInputWorker } from "./federation/input-worker";
import { FederationMarketService } from "./federation/market";
import { UnixMarketClient } from "./federation/market-client";
import { FederationMaterialExchange } from "./federation/material-exchange";
import { FederationOutboundService, FederationOutboundWorker } from "./federation/outbound";
import { createFederationPackageResolver } from "./federation/package-resolver";
import { FederationPermissionService } from "./federation/permissions";
import { FederationPreparationService } from "./federation/preparation";
import { FederationPreparationWorker } from "./federation/preparation-worker";
import { FederationResultStorage } from "./federation/result-storage";
import { FederationResultTransport } from "./federation/result-transport";
import { FederationResultWorker } from "./federation/result-worker";
import {
  loadFederationSender,
  loadFederationSigningKey,
  startFederationIngress,
} from "./federation/runtime";
import { FederationTrustRegistry } from "./federation/trust-registry";
import { FederationUsageService } from "./federation/usage";
import { FederationUsageExchange } from "./federation/usage-exchange";
import { FederationWorkflowExecutor } from "./federation/workflow-executor";
import {
  AgentDispatcher,
  JobCancellationOutbox,
  JobWorkRootReleaseOutbox,
} from "./grpc/dispatcher";
import { JobDispatchOutbox } from "./grpc/job-dispatch-outbox";
import { createGrpcConnectNodeHandler } from "./grpc/server";
import { attachGrpcTransportErrorHandlers } from "./grpc/transport-errors";
import { authMiddleware } from "./middleware/auth";
import { automationScopeMiddleware } from "./middleware/automation-scope";
import { createErrorHandler, createNotFoundHandler } from "./middleware/error-handler";
import { principalBinder } from "./middleware/principal-binder";
import { securityHeaders } from "./middleware/security-headers";
import { PreferenceService } from "./preferences/preference-service";
import { createActiveOrganizationRoutes } from "./routes/active-organization";
import { createAdminAgentRoutes } from "./routes/admin-agents";
import { createAdminAuthzRoutes } from "./routes/admin-authz";
import { createAdminBrandingRoutes } from "./routes/admin-branding";
import { createAdminDataMarketRoutes } from "./routes/admin-data-market";
import { createAdminDesensitizeRoutes } from "./routes/admin-desensitize";
import { createAdminFederationRoutes } from "./routes/admin-federation";
import { createAdminFederationPermissionRoutes } from "./routes/admin-federation-permissions";
import { createAdminFederationStorageRoutes } from "./routes/admin-federation-storage";
import { createAdminFileTransferAuditConfigRoutes } from "./routes/admin-file-transfer-audit-config";
import { createAdminSshCredentialRoutes } from "./routes/admin-ssh-credentials";
import { createAdminSshRecordingRoutes } from "./routes/admin-ssh-recordings";
import { createAdminSshSessionRoutes } from "./routes/admin-ssh-sessions";
import { createAdminSsoRoutes } from "./routes/admin-sso";
import { createAgentBinaryRoutes } from "./routes/agent-binaries";
import { createAgentRegistrationRoutes } from "./routes/agent-registration";
import { createAgentSpackMaterialRoutes } from "./routes/agent-spack-materials";
import { createAgentRoutes } from "./routes/agents";
import { createAuditLogRoutes } from "./routes/audit-log";
import { createAuthRoutes } from "./routes/auth";
import { createAutomationCredentialRoutes } from "./routes/automation-credentials";
import { createComputeProviderRoutes } from "./routes/compute-providers";
import { buildCpRouter } from "./routes/cp";
import { createDataMarketRoutes } from "./routes/data-market";
import { dslRoutes } from "./routes/dsl";
import { createFederationAgreementRoutes } from "./routes/federation-agreements";
import { createFederationAssetRoutes } from "./routes/federation-assets";
import { createFederationCommercialRoutes } from "./routes/federation-commercial";
import { createFederationMarketRoutes } from "./routes/federation-market";
import { createFederationOutboundRoutes } from "./routes/federation-outbound";
import { createFileRoutes } from "./routes/files";
import { healthRoutes } from "./routes/health";
import { createInterconnectRoutes } from "./routes/interconnect";
import { createJobRoutes } from "./routes/jobs";
import { createMeCapabilityRoutes } from "./routes/me-capabilities";
import { buildMeteringRouter, DrizzleWebhookRepository } from "./routes/metering";
import { createMetricsRoutes, recordRequest } from "./routes/metrics";
import { createNetDriveRoutes } from "./routes/netdrive";
import { createPlatformUserRoutes } from "./routes/platform-users";
import { createPreferenceRoutes } from "./routes/preferences";
import { createQueueRoutes } from "./routes/queues";
import { createSandboxAccountRoutes } from "./routes/sandbox-accounts";
import { createSandboxPolicyRoutes } from "./routes/sandbox-policy";
import { createSandboxScriptRoutes } from "./routes/sandbox-scripts";
import { createSchedulerRoutes } from "./routes/scheduler";
import { createSoftwareRoutes } from "./routes/software";
import { createSshRoutes } from "./routes/ssh";
import { createStorageRoutes } from "./routes/storage";
import { createTerminalRoutes } from "./routes/terminal";
import { createWorkflowRoutes } from "./routes/workflows";
import { createWsRoutes } from "./routes/ws";
import { QueueWaitAggregator } from "./scheduler/queue-wait-aggregator";
import { reconcileStaleAgentHeartbeats } from "./services/agent-heartbeat-sweeper";
import { AgentManager } from "./services/agent-manager";
import { AgentRegistrationService } from "./services/agent-registration";
import { writeAudit } from "./services/audit-log-writer";
import { ClusterFileRootService } from "./services/cluster-file-root";
import { ComputeProviderService } from "./services/compute-providers";
import { buildCpBindings } from "./services/cp-bindings";
import { CpConsoleService } from "./services/cp-console";
import {
  DataDeliveryResolver,
  RestrictedSandboxDeliveryBinder,
  revokeDataDeliveryJobs,
} from "./services/data-delivery";
import {
  DataDeliveryRevocationOutbox,
  DataGrantRevocationCoordinator,
} from "./services/data-delivery-revocations";
import { PgDataImportCoordinator } from "./services/data-import-coordinator-drizzle";
import { DataMarketService, type DataUploadPort } from "./services/data-market";
import { PgDataMarketRepository } from "./services/data-market-repository-drizzle";
import {
  DataMarketObjectUploadService,
  PgDataMarketObjectUploadRepository,
  UnavailableDataMarketUploadPort,
} from "./services/data-market-upload";
import {
  DataPrerequisitePlacementGate,
  DataPrerequisitePlanner,
} from "./services/data-prerequisite";
import { PgDataPrerequisiteRepository } from "./services/data-prerequisite-repository-drizzle";
import { DataScanCoordinator, PgDataScanCertificateLookup } from "./services/data-scan-coordinator";
import { createPgDataSelectionValidator } from "./services/data-selection-validation";
import { FileService } from "./services/file-service";
import { InterconnectService } from "./services/interconnect";
import { JobLogAccessAuditor } from "./services/job-log-access-auditor";
import { JobLogsService } from "./services/job-logs-service";
import { JobService } from "./services/job-service";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "./services/license-runtime-governance";
import { createMeteringBundle } from "./services/metering-binding";
import { MeteringCron } from "./services/metering-cron";
import { WebhookDispatcher } from "./services/metering-webhook";
import { MeteringWebhookEmitter } from "./services/metering-webhook-emitter";
import { MeteringWorkflowAttributionService } from "./services/metering-workflow-attribution";
import { NetDriveService } from "./services/netdrive";
import { createAuthorizedNetDriveDownloadMint } from "./services/netdrive-download-authorizer";
import { PgFileTransferStore } from "./services/pg-file-transfer-store";
import { PlacementOrchestrator } from "./services/placement-orchestrator";
import { PgPlacementPlanStore, PlacementPlanService } from "./services/placement-plan";
import { QueueInventoryService } from "./services/queue-inventory";
import { QueueObservabilityService } from "./services/queue-observability";
import { QueueRegistryService } from "./services/queue-registry";
import { SandboxArtifactReleaseService } from "./services/sandbox-artifact-release";
import { SandboxExecutionResolver } from "./services/sandbox-execution-resolver";
import { SandboxExecutionStatsService } from "./services/sandbox-execution-stats";
import { SandboxManifestSigner } from "./services/sandbox-manifest-signer";
import { SandboxNodeExecutor } from "./services/sandbox-node-executor";
import { SandboxPolicyService } from "./services/sandbox-policy";
import { ShellExecRegistry } from "./services/shell-exec-registry";
import { SoftwareAvailabilityService } from "./services/software-availability";
import { SshGateway } from "./services/ssh-gateway";
import { makeObjectStoreRecordingSink } from "./services/ssh-recording";
import { StorageQuotaService } from "./services/storage-quota";
import { TerminalService } from "./services/terminal-service";
import { TransferRegistry } from "./services/transfer-registry";
import { TransferRunner } from "./services/transfer-runner";
import { assertUsecasePackageExecutionAccess } from "./services/usecase-execution-authorizer";
import { PgArtifactStore, WorkflowArtifactService } from "./services/workflow-artifact";
import { WorkflowArtifactFiles } from "./services/workflow-artifact-files";
import { registerWorkflowAuthorization } from "./services/workflow-authorization";
import { createWorkflowPlacementBuilder } from "./services/workflow-placement-builder";
import {
  InstalledRegistry,
  PgAgentMetricsRecorder,
  PolicyPusher,
  PolicyStore,
  SoftwareOperationService,
} from "./software-governance";
import {
  canOperateSpackAgent,
  createSpackDeliveryAccess,
} from "./software-governance/spack-delivery-access";
import { SpackMaterialDelivery } from "./software-governance/spack-material-delivery";
import { createRealMinioBackend, loadMinioConfigFromEnv } from "./storage/minio-client";
import { WorkflowAsyncRunner } from "./workflow/async-runner";
import { cancelWorkflowJobs } from "./workflow/cancel-jobs";
import { createDatasetPreflight, type DatasetPreflightDeps } from "./workflow/dataset-preflight";
import { createDbPackageStore } from "./workflow/db-package-store";
import { WorkflowDraftService } from "./workflow/draft-service";
import { readWorkflowPublishedFiles, saveWorkflowPublishedFiles } from "./workflow/execution-jobs";
import {
  type LeasedWorkflowJournal,
  WorkflowExecutionJournalStore,
} from "./workflow/execution-journal";
import { createFileStager } from "./workflow/file-stager";
import { completionFromJob, JobCompletionRegistry } from "./workflow/job-completion-registry";
import { createJobSubmitter } from "./workflow/job-submitter";
import {
  PgWorkflowNamedReferenceRepository,
  WorkflowNamedReferenceResolver,
} from "./workflow/named-reference-resolver";
import { createPackageResolver } from "./workflow/package-resolver";
import { parseWorkflowYaml } from "./workflow/parser";
import { constrainWorkflowResources } from "./workflow/resource-limits";
import { WorkflowRunRegistry } from "./workflow/run-registry";
import { createWorkflowRunner } from "./workflow/runner";
import { stageWorkflowInputs } from "./workflow/stage-inputs";
import { submitWorkflowJob } from "./workflow/submit-job";

const config = loadServerConfig();
const logger = createLogger("server", config.LOG_LEVEL);
const runtimeGlobal = globalThis as typeof globalThis & { __kuintessenceServerDb?: PgDb };
const db =
  config.NODE_ENV === "development" && runtimeGlobal.__kuintessenceServerDb
    ? runtimeGlobal.__kuintessenceServerDb
    : createPgDb(config.DATABASE_URL, {
        max: config.DB_MAX_CONNECTIONS,
        idle_timeout: config.DB_IDLE_TIMEOUT_SEC,
      });
if (config.NODE_ENV === "development") runtimeGlobal.__kuintessenceServerDb = db;

const jobLogAccessAuditor = new JobLogAccessAuditor(async (event) => {
  await writeAudit(db, {
    actor: event.actorUserId,
    action: "job.logs.read",
    target: `job:${event.jobId}`,
    diff: { after: { access: event.access, scope: event.scope } },
  });
});

async function resolveRecordingActorUserId(actor: string): Promise<string | null> {
  const [byEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, actor))
    .limit(1);
  if (byEmail) return byEmail.id;
  const [byId] = await db.select({ id: users.id }).from(users).where(eq(users.id, actor)).limit(1);
  return byId?.id ?? null;
}

// in-process event bus for WS fan-out. Single-Server by design;
// multi-Server coordination requires a shared pub/sub adapter.
const eventBus = new EventBus();

const preferenceService = new PreferenceService(db);
const dispatcher = new AgentDispatcher();
const jobCancellationOutbox = new JobCancellationOutbox(db, dispatcher);
let federationDispatchAuthorization: FederationDispatchAuthorization | undefined;
let federationDataDispatch = new FederationDataDispatch(db);
const jobDispatchOutbox = new JobDispatchOutbox(
  db,
  dispatcher,
  async (runId, target) => {
    if (!federationDispatchAuthorization)
      throw new WorkflowExecutionInterrupted("Federation dispatch authorization is unavailable", {
        retryable: false,
      });
    return federationDispatchAuthorization.prepare(runId, target);
  },
  async (agentId, message) => {
    return federationDataDispatch.prepare(agentId, message);
  },
  (manifest) => {
    if (!sandboxManifestSigner)
      throw new WorkflowExecutionInterrupted("Sandbox signature renewal is unavailable");
    return sandboxManifestSigner.sign(manifest);
  },
);
const jobWorkRootReleaseOutbox = new JobWorkRootReleaseOutbox(db, dispatcher);
const dataScanCoordinator = new DataScanCoordinator(
  new PgDataImportCoordinator(db),
  dispatcher,
  new PgDataScanCertificateLookup(db),
);
await dataScanCoordinator.recoverPending();
const terminalService = new TerminalService();
const shellExecRegistry = new ShellExecRegistry();
const transferRegistry = new TransferRegistry();
const jobLogsService = new JobLogsService(dispatcher);
const fileService = new FileService(new PgFileTransferStore(db));
fileService.attachShell(dispatcher, shellExecRegistry);

const authzService = new AuthzService({
  mode: config.AUTHZ_MODE,
  endpoint: config.AUTHZ_SPICEDB_ENDPOINT,
  token: config.AUTHZ_SPICEDB_TOKEN,
  schemaPath: config.AUTHZ_SCHEMA_PATH,
  db,
  logger,
  platformAdminDegrade: config.AUTHZ_PLATFORM_ADMIN_DEGRADE,
});
const agentManager = new AgentManager(db, authzService, {
  computeHealthMaxAgeSec: config.COMPUTE_HEALTH_MAX_AGE_SEC,
  computeHealthMaxFutureSkewSec: config.COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC,
});
await reconcileStaleAgentHeartbeats(agentManager, config.AGENT_HEARTBEAT_TIMEOUT_SEC, logger);
if (config.AGENT_HEARTBEAT_SWEEP_INTERVAL_SEC > 0) {
  setInterval(() => {
    reconcileStaleAgentHeartbeats(agentManager, config.AGENT_HEARTBEAT_TIMEOUT_SEC, logger).catch(
      (err) => logger.error({ err }, "Agent heartbeat reconciliation failed"),
    );
  }, config.AGENT_HEARTBEAT_SWEEP_INTERVAL_SEC * 1_000).unref?.();
}
const queueInventory = new QueueInventoryService(db, {
  maxAgeSec: config.QUEUE_INVENTORY_MAX_AGE_SEC,
  maxFutureSkewSec: config.QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC,
});
const queueRegistry = new QueueRegistryService(db, authzService, {
  inventory: queueInventory,
  validationMode: config.QUEUE_VALIDATION_MODE,
});
const clusterFileRootService = new ClusterFileRootService(db, authzService);
const storageQuotaService = new StorageQuotaService(db);
if (config.AUTHZ_MODE !== "off") {
  try {
    await authzService.writeSchemaFromDisk();
    logger.info(
      { endpoint: config.AUTHZ_SPICEDB_ENDPOINT, mode: config.AUTHZ_MODE },
      "SpiceDB authorization schema loaded",
    );
    const recovered = await authzService.processOutbox(config.AUTHZ_OUTBOX_BATCH_SIZE);
    if (recovered.processed > 0 || recovered.dead > 0) {
      logger.info(recovered, "Processed SpiceDB authorization outbox after schema recovery");
    }
  } catch (err) {
    if (config.AUTHZ_MODE === "enforce") {
      throw err;
    }
    logger.warn({ err }, "SpiceDB authorization schema load failed in shadow mode");
  }
  if (config.AUTHZ_OUTBOX_INTERVAL_SEC > 0) {
    setInterval(() => {
      authzService
        .processOutbox(config.AUTHZ_OUTBOX_BATCH_SIZE)
        .then((result) => {
          if (result.processed > 0 || result.dead > 0) {
            logger.info(result, "Processed SpiceDB authorization outbox");
          }
        })
        .catch((err) => logger.warn({ err }, "SpiceDB authorization outbox failed"));
    }, config.AUTHZ_OUTBOX_INTERVAL_SEC * 1000).unref?.();
  }
}

// Metering subsystem (PRD F23). The composition-root factory
// returns the Drizzle-backed repository when a live DB is provided, so the
// production Server uses real Postgres while tests can still drop in the
// in-memory variant by calling `createMeteringBundle()` with no `db`.
const meteringBundle = createMeteringBundle({ db });
// Surface the wired service / aggregator so the route + cron wiring below
// (and any future CLI/admin tooling) can reuse the same instances.
export const meteringService = meteringBundle.service;
export const meteringAggregator = meteringBundle.aggregator;
const meteringWorkflowAttribution = new MeteringWorkflowAttributionService(db);

// JobService is constructed after the metering bundle so it can record compute
// usage on every terminal job transition (the metering producer). MeteringService
// structurally satisfies JobMeteringRecorder.
const jobService = new JobService(
  db,
  eventBus,
  meteringService,
  config.ECOSYSTEM_RELEASE_TRUSTED_KEYS,
);
const backfilledJobProviders = await jobService.backfillProviderSnapshots();
if (backfilledJobProviders > 0) {
  logger.info({ jobs: backfilledJobProviders }, "Backfilled job provider snapshots");
}

// Metering rollup cron. Ticks hourly with daily/monthly
// boundary detection. Started after the rest of bootstrap below so a
// startup failure during route mounting doesn't leave a dangling timer.
const webhookRepo = new DrizzleWebhookRepository(db);
const meteringWebhookEmitter = config.METERING_WEBHOOK_ENABLED
  ? new MeteringWebhookEmitter({
      query: meteringService,
      repo: webhookRepo,
      dispatcher: new WebhookDispatcher(),
    })
  : undefined;
const meteringCron = new MeteringCron({
  aggregator: meteringAggregator,
  webhookEmitter: meteringWebhookEmitter,
});

// software governance + extended metrics ingest.
const installedRegistry = new InstalledRegistry(db);
const policyStore = new PolicyStore(db);
const policyPusher = new PolicyPusher(dispatcher);
const spackMaterialDelivery =
  config.SPACK_MATERIAL_DELIVERY_ENABLED &&
  config.SPACK_REGISTRY_URL &&
  config.SPACK_REGISTRY_JWT_SECRET &&
  config.SPACK_MATERIAL_TICKET_SECRET
    ? new SpackMaterialDelivery({
        registryUrl: config.SPACK_REGISTRY_URL,
        allowInsecureRegistryHttp: config.SPACK_REGISTRY_ALLOW_INSECURE_HTTP,
        registryJwtSecret: config.SPACK_REGISTRY_JWT_SECRET,
        registryJwtIssuer: config.SPACK_REGISTRY_JWT_ISSUER,
        registryJwtAudience: config.SPACK_REGISTRY_JWT_AUDIENCE,
        ticketSecret: config.SPACK_MATERIAL_TICKET_SECRET,
        bindings: config.SPACK_MATERIAL_RELEASES,
        references: new SpackMaterialReferences(db, config.SPACK_MATERIAL_EPOCH),
        access: createSpackDeliveryAccess(db, authzService),
        dispatcher,
      })
    : undefined;
await spackMaterialDelivery?.initialize();
const softwareOperations = new SoftwareOperationService(
  db,
  dispatcher,
  installedRegistry,
  async (input) => {
    if (!spackMaterialDelivery) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Server Spack material delivery is not configured; unmanaged installation is disabled",
        422,
      );
    }
    return spackMaterialDelivery.prepareOperation(input);
  },
  async (input) => {
    if (!(await canOperateSpackAgent(db, authzService, input))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent operation permission denied", 403);
    }
  },
  async (runId, target) => {
    if (!federationDispatchAuthorization)
      throw new WorkflowExecutionInterrupted(
        "Federation installation authorization is unavailable",
        {
          retryable: false,
        },
      );
    return federationDispatchAuthorization.prepare(runId, target);
  },
);
const metricsRecorder = new PgAgentMetricsRecorder(db);
const queueObservability = new QueueObservabilityService(db, queueInventory);
const licenseRuntimeGovernance = new LicenseRuntimeGovernanceService(
  new PgGovernanceRepository(db),
);
const softwareAvailability = new SoftwareAvailabilityService(
  db,
  {
    onlineAgentIds: () => dispatcher.onlineAgentIds(),
    governance: licenseRuntimeGovernance,
  },
  authzService,
);
const dataPrerequisiteRepository = new PgDataPrerequisiteRepository(db);
const dataDeliveryRevocationOutbox = new DataDeliveryRevocationOutbox(db, dispatcher);
const dataGrantRevocationCoordinator = new DataGrantRevocationCoordinator(
  db,
  dataDeliveryRevocationOutbox,
);
const dataPrerequisites = new DataPrerequisitePlacementGate(
  new DataPrerequisitePlanner(dataPrerequisiteRepository),
);

// Orchestrator combines the placement pipeline + gRPC dispatcher.
// Called after every job submit to route the job to an online agent.
const orchestrator = new PlacementOrchestrator({
  agentManager,
  jobService,
  preferenceService,
  dispatcher,
  jobCancellations: jobCancellationOutbox,
  dispatchOutbox: jobDispatchOutbox,
  queueRegistry,
  computeHealth: {
    enforce: config.COMPUTE_HEALTH_ENFORCE,
    maxAgeSec: config.COMPUTE_HEALTH_MAX_AGE_SEC,
    maxFutureSkewSec: config.COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC,
  },
  db,
  softwareAvailability,
  softwareOperations,
  softwareInstallTimeoutMs: config.SERVER_JOB_COMPLETION_TIMEOUT_SEC * 1000,
  dataPrerequisites,
  loadPersistedDataPrerequisites: (jobId) => jobService.listDataPrerequisites(jobId),
  resolveLicensedMaterials: (input) =>
    licenseRuntimeGovernance.resolveLicensedMaterialMounts(input),
});

// Workflow run persistence and list/detail queries.
const workflowRegistry = new WorkflowRunRegistry(db);
const workflowDraftService = new WorkflowDraftService(db);
const placementPlanService = new PlacementPlanService(
  new PgPlacementPlanStore(db),
  createWorkflowPlacementBuilder(db),
);
let netdriveServiceForWorkflowOutputs: NetDriveService | undefined;
let dataMarketUploadPort: DataUploadPort = new UnavailableDataMarketUploadPort();
let transferRunner: TransferRunner | undefined;
const sandboxArtifactReleaseService = new SandboxArtifactReleaseService(dispatcher);
const workflowArtifactFiles = new WorkflowArtifactFiles(db, async (input) => {
  if (!transferRunner || !netdriveServiceForWorkflowOutputs)
    throw new Error("NetDrive is unavailable for Sandbox artifacts");
  await waitForWorkflowOutputTransfer({
    transferId: crypto.randomUUID(),
    ownerId: input.ownerId,
    source: input.source,
    target: input.target,
    agentId: input.agentId,
    workflowRunId: input.artifact.workflowRunId,
    jobId: input.artifact.producerJobId ?? undefined,
  });
  const listed = await netdriveServiceForWorkflowOutputs.listFiles(input.ownerId, {
    prefix: input.target,
    limit: 1,
    offset: 0,
  });
  const file = listed.files.find((item) => item.path === input.target);
  if (!file || file.sha256 !== input.sha256 || file.size !== input.sizeBytes)
    throw new Error("Persisted Sandbox artifact failed size/hash verification");
  return { netdriveFileId: file.id, storageRef: input.target };
});
const workflowArtifactService = new WorkflowArtifactService(
  new PgArtifactStore(db),
  workflowArtifactFiles,
  (replica) => sandboxArtifactReleaseService.release(replica),
);

if (config.SANDBOX_ARTIFACT_GC_INTERVAL_SEC > 0) {
  setInterval(() => {
    workflowArtifactService
      .collectGarbage()
      .then((removed) => {
        if (removed > 0) logger.info({ removed }, "Released expired Sandbox artifact replicas");
      })
      .catch((err) => logger.warn({ err }, "Sandbox artifact GC sweep failed"));
  }, config.SANDBOX_ARTIFACT_GC_INTERVAL_SEC * 1_000).unref?.();
}
const sandboxExecutionResolver = new SandboxExecutionResolver(db);
const sandboxExecutionStats = new SandboxExecutionStatsService(db);
const sandboxPolicyService = new SandboxPolicyService(db, {
  sandboxEnabled: config.SANDBOX_ENABLED,
  impersonationEnabled: config.SANDBOX_IMPERSONATION_ENABLED,
  selfAccountEnabled: config.SANDBOX_SELF_ACCOUNT_ENABLED,
  degradedImpersonationAllowed: config.SANDBOX_DEGRADED_IMPERSONATION_ALLOWED,
  sharedServiceAllowed: config.SANDBOX_SHARED_SERVICE_ALLOWED,
  runtimePrecacheRequired: true,
  limits: {
    maxCpuCores: config.SANDBOX_MAX_CPU_CORES,
    maxMemoryMb: config.SANDBOX_MAX_MEMORY_MB,
    maxWallTimeSec: config.SANDBOX_MAX_WALL_TIME_SEC,
    maxPids: config.SANDBOX_MAX_PIDS,
    maxOutputBytes: config.SANDBOX_MAX_OUTPUT_BYTES,
    maxLogBytes: config.SANDBOX_MAX_LOG_BYTES,
  },
  disabledRuntimeProfileIds: [],
});
const sandboxManifestSigner = config.SANDBOX_ENABLED
  ? new SandboxManifestSigner({
      keyId: config.SANDBOX_SIGNING_KEY_ID,
      privateKeyPem:
        config.SANDBOX_SIGNING_PRIVATE_KEY_PEM ??
        (() => {
          throw new Error("SANDBOX_SIGNING_PRIVATE_KEY_PEM is required when SANDBOX_ENABLED=true");
        })(),
    })
  : undefined;

const app = new Hono();

app.onError(createErrorHandler(logger));
app.notFound(createNotFoundHandler());
app.use("*", cors());
app.use("*", securityHeaders({ contentSecurityPolicy: config.WEB_CSP }));

// Request counter middleware (before any route so all requests are counted)
app.use("*", async (_c, next) => {
  recordRequest();
  await next();
});

// Prometheus metrics — public, no auth (Prometheus scrapes this without credentials)
app.route("/", createMetricsRoutes({ queueObservability }));

// Public routes
app.route("/api", healthRoutes);
app.route("/api", createAgentBinaryRoutes(config.AGENT_BINARIES_DIR));
if (spackMaterialDelivery) {
  // Dedicated operation credentials, not browser sessions. Never proxy to an external URL.
  app.route("/api", createAgentSpackMaterialRoutes(spackMaterialDelivery));
}
// Public DSL JSON Schema endpoint. Mounted on the public app
// (NO auth) so external editors and CI lint tools can pin the schema
// without a Server credential. Must stay BEFORE app.route("/api", protectedApi)
// to avoid being shadowed by the auth middleware.
app.route("/api", dslRoutes);
// auth routes now include OIDC login/callback/config-public.
// SSO_SECRET_KEY (when set) is the wrapping key for the sso_config secret;
// JWT_SECRET is the fallback so single-binary dev deployments still work.
const ssoSecretWrappingKey = config.SSO_SECRET_KEY ?? config.JWT_SECRET;
await bootstrapSsoConfig(db, {
  enabled: config.SSO_BOOTSTRAP_ENABLED,
  force: config.SSO_BOOTSTRAP_FORCE,
  issuerUrl: config.SSO_BOOTSTRAP_ISSUER_URL,
  clientId: config.SSO_BOOTSTRAP_CLIENT_ID,
  clientSecret: config.SSO_BOOTSTRAP_CLIENT_SECRET,
  redirectUri: config.SSO_BOOTSTRAP_REDIRECT_URI,
  groupMappingJson: config.SSO_BOOTSTRAP_GROUP_MAPPING,
  autoCreateUsers: config.SSO_BOOTSTRAP_AUTO_CREATE_USERS,
  secretWrappingKey: ssoSecretWrappingKey,
  logger,
});
app.route(
  "/api",
  createAuthRoutes(config.JWT_SECRET, db, {
    ssoSecretWrappingKey,
    webBaseUrl: config.WEB_BASE_URL,
    allowInsecureIssuer: config.NODE_ENV !== "production",
    devLoginEnabled: config.NODE_ENV !== "production",
    logger,
    authz: authzService,
    accessTokenTtlSec: config.AUTH_ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: config.AUTH_REFRESH_TOKEN_TTL_SEC,
  }),
);

// WebSocket routes. Auth is handled INSIDE the route (browsers
// can't pass Authorization headers on `new WebSocket()`, so we accept JWT
// via Sec-WebSocket-Protocol or ?token query). Therefore this is mounted
// OUTSIDE the bearer-header authMiddleware to avoid double-rejection.
app.route(
  "/ws",
  createWsRoutes({
    db,
    jwtSecret: config.JWT_SECRET,
    bus: eventBus,
    authz: authzService,
    upgrade: upgradeWebSocket,
  }),
);

// SSH gateway WebSocket route. Same auth-inside-route reasoning
// as the other WS routes. The gateway pushes SshOpen/SshData/SshClose to
// the Agent's connectRPC stream and forwards SshOutput/SshClosed back.
const sshGateway = new SshGateway({
  dispatcher,
  idleTimeoutMs: config.SSH_IDLE_TIMEOUT_SEC * 1000,
  maxSessionMs: config.SSH_MAX_SESSION_SEC * 1000,
  onSessionClosed: async (event) => {
    const tuples: AuthzTuple[] = [
      {
        ...sshSessionAgentTuple({ sessionId: event.sessionId, agentId: event.agentId }),
        operation: "delete",
      },
      { ...sshSessionPlatformTuple(event.sessionId), operation: "delete" },
    ];
    if (event.actorUserId) {
      tuples.push({
        ...sshSessionOpenerTuple({ sessionId: event.sessionId, userId: event.actorUserId }),
        operation: "delete",
      });
    }
    await authzService.enqueueMany(tuples);
  },
});
// periodic sweep enforcing idle timeout and/or absolute max-duration
// when either is configured. Cadence tracks the tighter of the two bounds.
if (config.SSH_IDLE_TIMEOUT_SEC > 0 || config.SSH_MAX_SESSION_SEC > 0) {
  const bounds = [config.SSH_IDLE_TIMEOUT_SEC, config.SSH_MAX_SESSION_SEC].filter((s) => s > 0);
  const sweepMs = Math.min(Math.min(...bounds) * 1000, 30_000);
  setInterval(() => {
    const idleClosed = config.SSH_IDLE_TIMEOUT_SEC > 0 ? sshGateway.sweepIdleSessions() : 0;
    const agedClosed = config.SSH_MAX_SESSION_SEC > 0 ? sshGateway.sweepAgedSessions() : 0;
    if (idleClosed + agedClosed > 0) {
      logger.info({ idleClosed, agedClosed }, "Force-closed expired SSH sessions");
    }
  }, sweepMs).unref?.();
  logger.info(
    {
      idleTimeoutSec: config.SSH_IDLE_TIMEOUT_SEC || null,
      maxSessionSec: config.SSH_MAX_SESSION_SEC || null,
    },
    "SSH session expiry sweep enabled",
  );
}
// F8.1 — periodically recompute per-agent historical P95 queue-wait from `jobs`
// history into agents.historical_p95_wait_sec, which the queue-wait scorer reads.
// Opt-in: 0 disables it.
if (config.SCHEDULER_QUEUE_WAIT_AGG_SEC > 0) {
  const queueWaitAggregator = new QueueWaitAggregator(db);
  setInterval(() => {
    queueWaitAggregator.recomputeAll().catch((err) => {
      logger.warn({ err }, "Queue-wait aggregation sweep failed");
    });
  }, config.SCHEDULER_QUEUE_WAIT_AGG_SEC * 1000).unref?.();
  logger.info(
    { intervalSec: config.SCHEDULER_QUEUE_WAIT_AGG_SEC },
    "Queue-wait P95 aggregation sweep enabled",
  );
}
// Production resolves SSH credentials from the encrypted vault table; dev keeps
// the env-mock (`SSH_CRED_<AGENT_ID>`) via the route default so a local stack
// needs no DB row. The wrapping key mirrors the cipher's: a dedicated
// SSO_SECRET_KEY when set, else the JWT signing key.
const sshResolveCredentials =
  config.NODE_ENV === "production"
    ? makeVaultResolver(makePgSshRowLoader(db), config.SSO_SECRET_KEY ?? config.JWT_SECRET)
    : undefined;
app.route(
  "/api/ssh",
  createSshRoutes({
    db,
    jwtSecret: config.JWT_SECRET,
    gateway: sshGateway,
    upgrade: upgradeWebSocket,
    resolveCredentials: sshResolveCredentials,
    authz: authzService,
  }),
);

// CP Console aggregation service. Uses the agentManager and
// policyStore wired above plus thin Drizzle adapters for jobs, users,
// audit, and netdrive.
const cpConsoleService = new CpConsoleService(
  buildCpBindings({
    db,
    agentManager,
    policyStore,
    policyPusher,
    onlineAgentIds: () => dispatcher.onlineAgentIds(),
  }),
);

// Protected routes
const protectedApi = new Hono();
protectedApi.use("*", authMiddleware(config.JWT_SECRET, db));
// principalBinder must run AFTER auth so `c.var.user` is populated. It
// looks up the user's orgId from the DB and exposes `principal` for the
// cp-rbac middleware and the metering routes.
protectedApi.use("*", principalBinder(db));
protectedApi.use("*", automationScopeMiddleware(db));
protectedApi.route("/", createAutomationCredentialRoutes(db));
// Server CA + cert issuance + mTLS for the Agent connectRPC stream.
const ca = await ensureCa(config.SERVER_CA_DIR);
const certStore = createPgCertStore(db);
const agentCertLookup = createPgAgentCertLookup(db);
const certService = createCertIssuanceService({ ca, store: certStore });
const agentRegistrationService = new AgentRegistrationService(db, ca, authzService);
app.route("/api", createAgentRegistrationRoutes(agentRegistrationService));
// Control-flow workflow execution. The runner is built per request
// bound to the submitting user; submitJob persists the materialized command,
// dispatches it through the placement orchestrator (carrying input staging),
// and awaits the agent's terminal status (collected outputs) via the
// completion registry, which the gRPC handler feeds.
const jobCompletionRegistry = new JobCompletionRegistry({
  load: async (jobId) => {
    const job = await jobService.getById(jobId);
    return job ? completionFromJob(job) : null;
  },
});
const workflowPackageStore = createDbPackageStore(db);
const workflowDataSelectionValidator = createPgDataSelectionValidator(db);
const namedReferenceResolver = new WorkflowNamedReferenceResolver(
  new PgWorkflowNamedReferenceRepository(db),
  {
    assertUse: (assetId, principal) =>
      softwareAvailability.assertAssetCapability(assetId, principal, "use"),
  },
);
const resolveWorkflowVersion = async (workflowVersionId: string) => {
  const [row] = await db
    .select({ yamlContent: workflowTemplates.yamlContent })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, workflowVersionId))
    .limit(1);
  if (!row) {
    return null;
  }
  return parseWorkflowYaml(row.yamlContent);
};

const workflowDatasetPreflightDeps: DatasetPreflightDeps = {
  loadUsecasePackage: async (usecaseVersionId) =>
    (await workflowPackageStore.getById(usecaseVersionId))?.spec ?? null,
  assertUsecaseExecutionAccess: (input) =>
    assertUsecasePackageExecutionAccess(db, input.usecaseVersionId, input.requester),
  resolveWorkflowVersion,
  verifyAccess: (input) => dataPrerequisiteRepository.verifyAccess(input),
  validateUsecase: (input) => workflowDataSelectionValidator.validateUsecase(input),
};
const validateWorkflowDatasetInputs = createDatasetPreflight(workflowDatasetPreflightDeps);

async function assertWorkflowExecutionMembership(input: {
  userId: string;
  orgId: string | null;
}): Promise<void> {
  if (!input.orgId) return;
  const [membership] = await db
    .select({ id: userOrgMemberships.id })
    .from(userOrgMemberships)
    .where(
      and(eq(userOrgMemberships.userId, input.userId), eq(userOrgMemberships.orgId, input.orgId)),
    )
    .limit(1);
  if (!membership) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Workflow submitter is no longer a member of the active organization",
      403,
    );
  }
}

const makeRunner =
  (
    submittedBy: string,
    userRole: RoleName,
    persistRun = true,
    activeRunId?: string,
    rawPlacementConfig?: WorkflowPlacementConfig,
    activeOrgId?: string | null,
    executionLease?: LeasedWorkflowJournal,
  ) =>
  async (yaml: string) => {
    if (executionLease && (executionLease.runId !== activeRunId || activeOrgId === undefined))
      throw new WorkflowExecutionInterrupted(
        "Workflow runner requires its run and organization scope",
        { retryable: false },
      );
    const federationBinding = activeRunId
      ? await loadFederationWorkflowBinding(db, activeRunId)
      : null;
    const federationSnapshot = federationBinding?.snapshot;
    if (
      federationSnapshot &&
      (submittedBy !== federationSnapshot.identity.userId ||
        activeOrgId !== federationSnapshot.identity.orgId ||
        userRole !== "user" ||
        !executionLease)
    )
      throw new WorkflowExecutionInterrupted(
        "Federation workflow requires its original restricted identity and lease",
        { retryable: false },
      );
    const awaitWorkflowJob = async (jobId: string) => {
      try {
        const result = await jobCompletionRegistry.awaitCompletion(
          jobId,
          config.SERVER_JOB_COMPLETION_TIMEOUT_SEC * 1000,
          executionLease?.signal,
        );
        await executionLease?.renew();
        return result;
      } catch (cause) {
        if (cause instanceof WorkflowExecutionInterrupted) throw cause;
        if (executionLease)
          throw new WorkflowExecutionInterrupted("Waiting for the original workflow Job result", {
            cause,
          });
        throw cause;
      }
    };
    const placementConfig = WorkflowPlacementConfigSchema.parse(rawPlacementConfig ?? {});
    const authorizeJobSubmission = async (input: {
      jobId: string;
      orgId: string | null;
      queueId: string | null;
    }): Promise<void> => {
      const authorizationTuples = jobSubmissionTuples({
        ...input,
        userId: submittedBy,
      });
      try {
        if (authzService.mode === "enforce") {
          await authzService.writeRelationships(authorizationTuples);
        }
        await authzService.enqueueMany(authorizationTuples);
      } catch (cause) {
        if (executionLease)
          throw new WorkflowExecutionInterrupted(
            "Workflow Job authorization projection is unavailable",
            { cause },
          );
        throw cause;
      }
    };
    const resolveFileInput = async (value: unknown) => {
      if (!activeRunId) return value;
      await executionLease?.renew();
      const resolved = await workflowArtifactFiles.resolve(
        value,
        { workflowRunId: activeRunId, ownerId: submittedBy },
        workflowArtifactService,
      );
      await executionLease?.renew();
      return resolved;
    };
    const sandboxExecutor =
      sandboxManifestSigner && activeRunId
        ? new SandboxNodeExecutor({
            db,
            resolver: sandboxExecutionResolver,
            signer: sandboxManifestSigner,
            jobService,
            orchestrator,
            artifactService: workflowArtifactService,
            resolveFileInput,
            awaitCompletion: awaitWorkflowJob,
            executionLease,
            resourceLimits: federationSnapshot?.request.resources,
            federationTargets: federationSnapshot
              ? (federationSnapshot.executionTargets ?? [])
              : undefined,
            requiredRuntime: federationSnapshot?.environment.sandboxRuntime,
            submittedBy,
            ...(activeOrgId !== undefined ? { orgId: activeOrgId } : {}),
            userRole,
            authorizeJobSubmission,
            workflowRunId: activeRunId,
            defaultExecutionIdentity: placementConfig.defaultExecutionIdentity,
            resolvePolicy: (target) => sandboxPolicyService.effectiveFor(target),
            governance: licenseRuntimeGovernance,
            resolvePlannedAgents: async (nodeId) => {
              const [latest] = await placementPlanService.list(activeRunId);
              const planned = latest?.nodes.find((candidate) => candidate.nodeId === nodeId);
              return planned ? [planned.preferredAgentId, ...planned.fallbackAgentIds] : [];
            },
            recordExecutionStats: (input) => sandboxExecutionStats.record(input),
            limits: {
              pids: config.SANDBOX_MAX_PIDS,
              outputBytes: config.SANDBOX_MAX_OUTPUT_BYTES,
              logBytes: config.SANDBOX_MAX_LOG_BYTES,
            },
          })
        : undefined;
    const canInstallSoftware = async (assetId: string, spec: string) => {
      const availability = await softwareAvailability.resolve(
        {
          assetRef: { id: assetId, kind: "spack-package" },
          rawSpec: spec,
          installable: true,
        },
        {
          sub: submittedBy,
          userId: submittedBy,
          role: userRole,
          email: `${submittedBy}@local`,
          orgId: activeOrgId ?? null,
          orgIds: activeOrgId ? [activeOrgId] : [],
          memberships: [],
          capabilities: [],
        },
      );
      return availability.installableAvailable.length > 0;
    };
    return createWorkflowRunner({
      executeFederation: async (node, invocation, parameters, files) => {
        if (!executionLease || !activeOrgId || !invocation || federationSnapshot)
          throw new WorkflowExecutionInterrupted(
            "Federation nodes require a source durable run and organization",
            { retryable: false },
          );
        if (!federationWorkflowExecutor)
          throw new WorkflowExecutionInterrupted("Federation execution is unavailable");
        return federationWorkflowExecutor.execute(
          { userId: submittedBy, orgId: activeOrgId },
          executionLease,
          node,
          invocation,
          parameters,
          files,
        );
      },
      resolveFileInput,
      journal: executionLease,
      deferSpackActivation: true,
      // Persist runs for audit and visibility in `workflow list`.
      ...(persistRun
        ? {
            persistRun: (name, result, graph) =>
              workflowRegistry.recordRun(name, submittedBy, result, graph),
          }
        : {}),
      resolvePackage: federationSnapshot
        ? createFederationPackageResolver(
            federationSnapshot,
            federationAssets,
            workflowPackageStore,
            canInstallSoftware,
          )
        : createPackageResolver(workflowPackageStore, canInstallSoftware),
      resolveWorkflowVersion: federationSnapshot
        ? async (id) => federationSnapshot.workflowVersions[id] ?? null
        : resolveWorkflowVersion,
      ...(sandboxExecutor
        ? {
            executeScript: async (node, ctx, invocation) => {
              if (federationSnapshot && !federationSnapshot.environment.sandboxRuntime)
                throw new WorkflowExecutionInterrupted(
                  "Federation Script lacks a locked sandbox runtime",
                  { retryable: false },
                );
              return sandboxExecutor.execute(node, ctx, invocation);
            },
          }
        : {}),
      submitJob: createJobSubmitter({
        prepare: async (spec) => {
          if (federationSnapshot)
            spec = {
              ...spec,
              resources: constrainWorkflowResources(
                spec.resources,
                federationSnapshot.request.resources,
              ),
            };
          await assertWorkflowExecutionMembership({
            userId: submittedBy,
            orgId: activeOrgId ?? null,
          });
          if (!spec.usecasePackageId) return spec;
          await assertUsecasePackageExecutionAccess(db, spec.usecasePackageId, {
            userId: submittedBy,
            orgId: activeOrgId ?? null,
          });
          const row = await workflowPackageStore.getById(
            spec.usecaseVersionId ?? spec.usecasePackageId,
          );
          if (!row) throw new Error(`usecase package not found: ${spec.usecasePackageId}`);
          const pkg = usecase.UsecasePackageSchema.parse(row.spec);
          if (!("softwareRef" in pkg)) {
            throw new Error(
              "Workflow execution requires a governed usecase package with a software selector",
            );
          }
          const dataSelections = await workflowDataSelectionValidator.validateUsecase({
            pkg,
            dataInputs: spec.dataInputs ?? {},
          });
          const selectedDataInputs = Object.fromEntries(
            Object.entries(spec.dataInputs ?? {}).map(([descriptor, input]) => {
              const selection = dataSelections.find((item) => item.descriptor === descriptor);
              return [
                descriptor,
                selection && input.targetPath === undefined
                  ? { ...input, targetPath: selection.stagePath }
                  : input,
              ];
            }),
          );
          const marketBackedLicensedMaterials = new Set(
            dataSelections.flatMap((selection) => selection.satisfiedLicensedMaterialSelectors),
          );
          return {
            ...spec,
            ...(Object.keys(selectedDataInputs).length > 0
              ? { dataInputs: selectedDataInputs }
              : {}),
            ...(spec.licensedMaterials
              ? {
                  licensedMaterials: spec.licensedMaterials.filter(
                    (material) => !marketBackedLicensedMaterials.has(material.selector),
                  ),
                }
              : {}),
          };
        },
        submit: async (spec) => {
          const job = await submitWorkflowJob({
            jobService,
            spec,
            submittedBy,
            role: userRole,
            orgId: activeOrgId,
            runId: activeRunId,
            workingDirBase: config.WORKFLOW_RUN_BASE,
            lease: executionLease,
          });
          await authorizeJobSubmission({ jobId: job.id, orgId: job.orgId, queueId: job.queueId });
          return { id: job.id };
        },
        dispatch: async (
          jobId,
          inputStaging,
          expectedOutputs,
          stdinText,
          licensedMaterials,
          softwareRequirements,
          schedulingStrategy,
          spackExecution,
        ) => {
          const job = await jobService.getById(jobId);
          if (!job) {
            jobCompletionRegistry.complete(jobId, {
              status: "failed",
              collected: {},
              errorMessage: "Workflow job record is unavailable.",
            });
            return;
          }
          try {
            const result = await orchestrator.placeAndDispatch({
              jobId,
              executionLease,
              spackExecution,
              federationTargets: federationSnapshot
                ? (federationSnapshot.executionTargets ?? [])
                : undefined,
              restrictedNoEgress: job.restrictedNoEgress,
              ...(activeRunId ? { workflowRunId: activeRunId } : {}),
              job: {
                name: job.name,
                command: job.command,
                resources: {
                  cpus: job.cpus,
                  memoryMb: job.memoryMb,
                  gpus: job.gpus ?? 0,
                  wallTimeSec: Number(job.wallTimeSec ?? 0),
                },
                workingDir: job.workingDir ?? undefined,
                envVars: job.envVars ?? undefined,
                ...(job.queueId
                  ? { schedulingStrategy: { queueId: job.queueId } }
                  : schedulingStrategy
                    ? { schedulingStrategy }
                    : {}),
                inputStaging,
                expectedOutputs,
                fileOutputDescriptors: job.fileOutputDescriptors ?? undefined,
                stdinText,
                ...(licensedMaterials ? { licensedMaterials } : {}),
                ...(softwareRequirements ? { softwareRequirements } : {}),
              },
              userId: submittedBy,
              userRole,
              // The job row carries the submitter's org (stamped at submit); use it
              // so org-level scheduling preferences and quotas apply to workflow jobs.
              orgId: job.orgId ?? null,
            });
            // The job will never run (no eligible agent / closed channel): resolve
            // the completion as failed so awaitCompletion — and the workflow node — fails
            // fast instead of hanging until the request times out.
            if (!result.dispatched && !result.pendingDelivery) {
              const failedJob = await jobService.getById(jobId);
              jobCompletionRegistry.complete(jobId, {
                status: "failed",
                collected: {},
                errorMessage:
                  failedJob?.errorMessage ?? "No eligible compute resource accepted the job.",
                ...(failedJob?.exitCode !== null && failedJob?.exitCode !== undefined
                  ? { exitCode: failedJob.exitCode }
                  : {}),
              });
            } else {
              const placedJob = await jobService.getById(jobId);
              if (placedJob?.providerOrgId) {
                await authzService
                  .enqueue(jobProviderTuple({ jobId, providerOrgId: placedJob.providerOrgId }))
                  .catch((err) => {
                    logger.warn(
                      { err, jobId, providerOrgId: placedJob.providerOrgId },
                      "Failed to enqueue workflow job provider authorization",
                    );
                  });
              }
            }
          } catch (err) {
            if (err instanceof WorkflowExecutionInterrupted) throw err;
            const errorMessage =
              err instanceof Error ? err.message : "Workflow job dispatch failed.";
            const failedJob = await jobService
              .updateStatus(
                jobId,
                "failed",
                undefined,
                undefined,
                errorMessage,
                undefined,
                undefined,
                undefined,
                undefined,
                executionLease,
              )
              .catch((updateErr) => {
                if (executionLease) throw updateErr;
                logger.warn(
                  { err: updateErr, jobId },
                  "Failed to mark workflow job failed after dispatch error",
                );
                return null;
              });
            jobCompletionRegistry.complete(jobId, {
              status: "failed",
              collected: {},
              errorMessage,
              ...(failedJob?.exitCode !== null && failedJob?.exitCode !== undefined
                ? { exitCode: failedJob.exitCode }
                : {}),
            });
            throw err;
          }
        },
        awaitCompletion: awaitWorkflowJob,
        collectFiles: async (jobId, spec, collected) => {
          try {
            return await collectWorkflowOutputFiles({
              jobId,
              spec,
              collected,
              ownerId: submittedBy,
              workflowRunId: activeRunId,
              executionLease,
            });
          } catch (cause) {
            if (executionLease && !(cause instanceof WorkflowExecutionInterrupted))
              throw new WorkflowExecutionInterrupted("Workflow file publication is pending", {
                cause,
              });
            throw cause;
          }
        },
      }),
    })(yaml);
  };
const workflowAsyncRunner = new WorkflowAsyncRunner({
  resolveWorkflowVersion,
  authorizeFederationExecution: async (runId, lease) => {
    if (!federationDispatchAuthorization)
      throw new WorkflowExecutionInterrupted("Federation workflow authorization is unavailable");
    await federationDispatchAuthorization.authorizeWorkflow(runId, lease);
  },
  registry: workflowRegistry,
  journal: new WorkflowExecutionJournalStore(db),
  resolveNamedReferences: (workflow, principal) =>
    namedReferenceResolver.resolve(workflow, principal),
  validateWorkflow: async (workflow, principal, runId) => {
    const binding = runId ? await loadFederationWorkflowBinding(db, runId) : null;
    const validate = binding
      ? createFederationDatasetPreflight(
          binding.snapshot,
          federationAssets,
          workflowDatasetPreflightDeps,
        )
      : validateWorkflowDatasetInputs;
    await validate(workflow, principal);
  },
  assertExecutionPrincipal: assertWorkflowExecutionMembership,
  preparePlacement: (runId, workflow, placementConfig) =>
    placementPlanService.prepare(runId, workflow, placementConfig),
  makeRunner: (submittedBy, role, runId, placementConfig, orgId, lease) =>
    makeRunner(submittedBy, role, false, runId, placementConfig, orgId, lease),
  awaitCheckpointPersistence: (runId) => workflowArtifactService.awaitCheckpointPersistence(runId),
  markArtifactsTerminal: (runId) => workflowArtifactService.markWorkflowTerminal(runId),
  cancelSubmittedJobs: async (runId) => {
    const results = await Promise.allSettled([
      cancelWorkflowJobs(
        runId,
        workflowRegistry,
        jobService,
        jobCancellationOutbox,
        jobCompletionRegistry,
      ),
      federationOutbound?.cancelWorkflow(runId),
    ]);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Workflow cancellation is pending");
  },
});

async function collectWorkflowOutputFiles(input: {
  jobId: string;
  spec: JobSubmission;
  collected: Record<string, string>;
  ownerId: string;
  workflowRunId?: string;
  executionLease?: LeasedWorkflowJournal;
}): Promise<Record<string, usecase.FileInputValue>> {
  const saved = input.executionLease
    ? await readWorkflowPublishedFiles(input.executionLease, input.jobId)
    : null;
  const job = await jobService.getById(input.jobId);
  if (saved !== null) {
    if (job?.agentId) {
      await jobWorkRootReleaseOutbox.enqueue(job.agentId, input.jobId);
      await jobWorkRootReleaseOutbox.redeliver(job.agentId);
    }
    return saved;
  }
  if (!job?.workingDir || !job.agentId) {
    if (input.executionLease && (input.spec.fileOutputDescriptors?.length ?? 0) > 0)
      throw new WorkflowExecutionInterrupted("Workflow output location is unavailable", {
        retryable: false,
      });
    if (input.executionLease)
      await saveWorkflowPublishedFiles(input.executionLease, input.jobId, {});
    logger.warn({ jobId: input.jobId }, "Workflow output files cannot be published");
    return {};
  }
  const outputJob = { workingDir: job.workingDir, agentId: job.agentId };
  let releasable = !input.executionLease;
  try {
    if (!transferRunner || !netdriveServiceForWorkflowOutputs) {
      if (input.executionLease && (input.spec.fileOutputDescriptors?.length ?? 0) > 0)
        throw new WorkflowExecutionInterrupted("Workflow file publication is unavailable");
      if (input.executionLease)
        await saveWorkflowPublishedFiles(input.executionLease, input.jobId, {});
      releasable = true;
      return {};
    }
    if (job.restrictedNoEgress) {
      if (input.executionLease)
        await saveWorkflowPublishedFiles(input.executionLease, input.jobId, {});
      releasable = true;
      logger.warn({ jobId: input.jobId }, "Restricted no-egress job outputs cannot be published");
      return {};
    }
    const files: Record<string, usecase.FileInputValue> = {};
    const declared = new Set(input.spec.fileOutputDescriptors ?? []);
    for (const out of input.spec.expectedOutputs) {
      if (!declared.has(out.descriptor)) {
        continue;
      }
      if (out.isBatch) {
        const batch = await publishBatchWorkflowOutputFiles({
          ...input,
          job: outputJob,
          out,
        });
        if (batch !== undefined) {
          files[out.descriptor] = batch;
        }
        continue;
      }
      const pathMetadata = input.collected[usecase.batchOutputPathsDescriptor(out.descriptor)];
      if (!(out.descriptor in input.collected) && !pathMetadata) {
        logger.warn(
          { jobId: input.jobId, descriptor: out.descriptor },
          "Workflow output lacks validated path metadata; cannot publish artifact",
        );
        continue;
      }
      const file = await publishOneWorkflowOutputFile({
        jobId: input.jobId,
        ownerId: input.ownerId,
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        job: outputJob,
        source: out.path.startsWith("/") ? out.path : posixPath.join(job.workingDir, out.path),
        target: workflowOutputPath(input.workflowRunId, input.jobId, out),
        fileName: posixPath.basename(out.path) || out.descriptor,
      });
      if (!file && input.executionLease)
        throw new WorkflowExecutionInterrupted("Published workflow file metadata is unavailable");
      if (file) {
        files[out.descriptor] = {
          fileMetadataId: file.id,
          fileMetadataName: file.name,
        };
      }
    }
    if (input.executionLease)
      await saveWorkflowPublishedFiles(input.executionLease, input.jobId, files);
    releasable = true;
    return files;
  } catch (cause) {
    if (input.executionLease && !(cause instanceof WorkflowExecutionInterrupted))
      throw new WorkflowExecutionInterrupted("Workflow file publication is pending", { cause });
    throw cause;
  } finally {
    if (releasable) {
      await jobWorkRootReleaseOutbox.enqueue(job.agentId, input.jobId);
      await jobWorkRootReleaseOutbox.redeliver(job.agentId);
    }
  }
}

async function publishBatchWorkflowOutputFiles(input: {
  jobId: string;
  out: { descriptor: string; path: string; isBatch: boolean };
  collected: Record<string, string>;
  ownerId: string;
  workflowRunId?: string;
  executionLease?: LeasedWorkflowJournal;
  job: { workingDir: string; agentId: string };
}): Promise<usecase.FileValue[] | undefined> {
  const pathsJson = input.collected[usecase.batchOutputPathsDescriptor(input.out.descriptor)];
  if (!pathsJson) {
    if (input.executionLease)
      throw new WorkflowExecutionInterrupted("Workflow output batch path metadata is unavailable");
    logger.warn(
      { jobId: input.jobId, descriptor: input.out.descriptor },
      "Batched workflow output lacks path metadata; cannot publish artifacts",
    );
    return undefined;
  }
  const paths = parseBatchOutputPaths(pathsJson, !!input.executionLease);
  const files: usecase.FileValue[] = [];
  for (const relPath of paths) {
    const source = relPath.startsWith("/")
      ? relPath
      : posixPath.join(input.job.workingDir, relPath);
    const target = workflowBatchOutputPath(
      input.workflowRunId,
      input.jobId,
      input.out.descriptor,
      relPath,
    );
    const file = await publishOneWorkflowOutputFile({
      jobId: input.jobId,
      ownerId: input.ownerId,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      source,
      target,
      job: input.job,
      fileName: posixPath.basename(relPath) || input.out.descriptor,
    });
    if (!file && input.executionLease)
      throw new WorkflowExecutionInterrupted("Published workflow batch metadata is unavailable");
    if (file) {
      files.push({ fileMetadataId: file.id, fileMetadataName: file.name });
    }
  }
  return files;
}

function parseBatchOutputPaths(pathsJson: string, strict = false): string[] {
  try {
    const parsed = JSON.parse(pathsJson);
    if (strict && (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")))
      throw new Error("Invalid batch metadata");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch (cause) {
    if (strict)
      throw new WorkflowExecutionInterrupted("Workflow output batch metadata is invalid", {
        cause,
        retryable: false,
      });
    return [];
  }
}

async function publishOneWorkflowOutputFile(input: {
  jobId: string;
  ownerId: string;
  workflowRunId?: string;
  job: { agentId: string };
  source: string;
  target: string;
  fileName: string;
}): Promise<{ id: string; name: string } | null> {
  const transferId = crypto.randomUUID();
  await waitForWorkflowOutputTransfer({
    transferId,
    ownerId: input.ownerId,
    source: input.source,
    target: input.target,
    agentId: input.job.agentId,
    jobId: input.jobId,
    workflowRunId: input.workflowRunId,
  });
  const listed = (await netdriveServiceForWorkflowOutputs?.listFiles(input.ownerId, {
    prefix: input.target,
    limit: 1,
    offset: 0,
  })) ?? { files: [] };
  const { files: committed } = listed;
  const file = committed.find((item) => item.path === input.target);
  return file ? { id: file.id, name: input.fileName } : null;
}

async function waitForWorkflowOutputTransfer(input: {
  transferId: string;
  ownerId: string;
  source: string;
  target: string;
  agentId: string;
  jobId?: string;
  workflowRunId?: string;
}): Promise<void> {
  if (!transferRunner) {
    return;
  }
  const runner = transferRunner;
  await new Promise<void>((resolve, reject) => {
    runner
      .start(
        input.ownerId,
        input.transferId,
        {
          direction: "cluster_to_cloud",
          source: input.source,
          target: input.target,
          agentId: input.agentId,
          ...(input.jobId ? { jobId: input.jobId } : {}),
          ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        },
        (event) => {
          if (event.state === "succeeded") {
            resolve();
          } else if (event.state === "failed") {
            reject(new Error(event.error || "workflow output transfer failed"));
          }
        },
      )
      .catch(reject);
  });
}

function workflowOutputPath(
  workflowRunId: string | undefined,
  jobId: string,
  out: { descriptor: string; path: string },
): string {
  const safeDescriptor = out.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = (posixPath.basename(out.path) || safeDescriptor).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  return `workflow-runs/${workflowRunId ?? "sync"}/jobs/${jobId}/${safeDescriptor}-${safeName}`;
}

function workflowBatchOutputPath(
  workflowRunId: string | undefined,
  jobId: string,
  descriptor: string,
  relPath: string,
): string {
  const safeDescriptor = descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, "_") || safeDescriptor;
  return `workflow-runs/${workflowRunId ?? "sync"}/jobs/${jobId}/${safeDescriptor}/${safeName}`;
}

const workflowSyncEnabled = config.NODE_ENV !== "production" || config.WORKFLOW_SYNC_ENABLED;
workflowAsyncRunner
  .recoverInterruptedRuns()
  .then((report) => {
    if (report.resumed > 0 || report.failedInterrupted > 0) {
      logger.warn(report, "Recovered interrupted workflow runs");
    }
  })
  .catch((err) => logger.error({ err }, "Failed to recover interrupted workflow runs"))
  .finally(() => workflowAsyncRunner.startRecovery());
fileService
  .reconcileInterruptedTransfers()
  .then((interrupted) => {
    if (interrupted > 0) {
      logger.warn({ interrupted }, "Marked interrupted file transfers");
    }
  })
  .catch((err) => logger.error({ err }, "Failed to reconcile interrupted file transfers"));
protectedApi.route(
  "/",
  createWorkflowRoutes({
    resolveUser: async (email) => {
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return u?.id ?? null;
    },
    makeRunner: makeRunner,
    registry: workflowRegistry,
    asyncRunner: workflowAsyncRunner,
    drafts: workflowDraftService,
    placementPlans: placementPlanService,
    authz: authzService,
    syncRunEnabled: workflowSyncEnabled,
  }),
);

protectedApi.route("/", createAdminAgentRoutes(certService, { authz: authzService }));
protectedApi.route("/", createAdminFederationRoutes(new FederationTrustRegistry(db), authzService));
protectedApi.route(
  "/",
  createAdminFederationPermissionRoutes(new FederationPermissionService(db), authzService),
);
const federationAssets = new FederationAssetService(db, {
  authorizeSoftware: (assetId, principal, capability) =>
    softwareAvailability.assertAssetCapability(assetId, principal, capability),
});
const federationSigningKey = await loadFederationSigningKey(config);
const federationSender = await loadFederationSender(config);
const federationOutbound =
  federationSigningKey && federationSender
    ? new FederationOutboundService(db, federationSigningKey, federationSender, federationAssets)
    : undefined;
const federationWorkflowExecutor =
  federationSigningKey && federationOutbound
    ? new FederationWorkflowExecutor(db, federationSigningKey.siteId, federationOutbound)
    : undefined;
if (federationOutbound) protectedApi.route("/", createFederationOutboundRoutes(federationOutbound));
const federationAttestation = federationSigningKey
  ? new FederationAttestationService(
      db,
      federationSigningKey,
      config.FEDERATION_ATTESTATION_SOCKET_PATH
        ? new UnixAttestationClient(config.FEDERATION_ATTESTATION_SOCKET_PATH)
        : undefined,
    )
  : undefined;
const federationCommercial = federationSigningKey
  ? new FederationCommercialSubmissionService(
      db,
      federationSigningKey.siteId,
      config.FEDERATION_COMMERCIAL_SOCKET_PATH
        ? new UnixCommercialClient(config.FEDERATION_COMMERCIAL_SOCKET_PATH)
        : undefined,
    )
  : undefined;
const federationMarket = federationSigningKey
  ? new FederationMarketService(
      db,
      federationSigningKey.siteId,
      config.FEDERATION_MARKET_SOCKET_PATH
        ? new UnixMarketClient(config.FEDERATION_MARKET_SOCKET_PATH)
        : undefined,
    )
  : undefined;
if (federationMarket) protectedApi.route("/", createFederationMarketRoutes(federationMarket));
const federationAccounting = federationSigningKey
  ? new FederationAccountingCollection(db, federationSigningKey.siteId, (agentId, request) =>
      dispatcher.pushFederationAccounting(agentId, request),
    )
  : undefined;
const federationUsage = federationSigningKey
  ? new FederationUsageService(db, federationSigningKey)
  : undefined;
const federationUsageExchange = federationSigningKey
  ? new FederationUsageExchange(db, federationSigningKey, federationSender)
  : undefined;
if (federationSigningKey && federationCommercial)
  protectedApi.route(
    "/",
    createFederationCommercialRoutes(
      new FederationCommercialAgreementService(db, federationSigningKey),
      federationCommercial,
      federationUsage,
      federationUsageExchange,
      new FederationCommercialExecutionService(
        db,
        federationSigningKey,
        config.FEDERATION_MARKET_SOCKET_PATH
          ? new UnixMarketClient(config.FEDERATION_MARKET_SOCKET_PATH)
          : undefined,
      ),
    ),
  );
const federationPreparation = federationSigningKey
  ? new FederationPreparationService(db, federationSigningKey.siteId, federationAssets)
  : undefined;
federationDispatchAuthorization = federationPreparation
  ? new FederationDispatchAuthorization(
      db,
      federationPreparation,
      queueRegistry,
      softwareAvailability,
      sandboxPolicyService,
    )
  : undefined;
jobDispatchOutbox.start();
jobCancellationOutbox.start();
protectedApi.route("/", createFederationAssetRoutes(federationAssets, federationPreparation));
if (federationSigningKey)
  protectedApi.route(
    "/",
    createFederationAgreementRoutes(
      new FederationAgreementService(db, federationSigningKey),
      federationAttestation,
    ),
  );
protectedApi.route("/", createActiveOrganizationRoutes(db));
protectedApi.route("/", createPlatformUserRoutes(db, authzService));
protectedApi.route(
  "/",
  createMeCapabilityRoutes({ softwarePublisherRoles: config.REGISTRY_PUBLISHER_ROLES }),
);
protectedApi.route(
  "/",
  createAdminAuthzRoutes(db, {
    authz: authzService,
    rawTupleAdminEnabled: config.AUTHZ_RAW_TUPLE_ADMIN_ENABLED,
  }),
);
protectedApi.route("/", createAdminBrandingRoutes(db, { authz: authzService }));
protectedApi.route("/", createAgentRoutes(agentManager, { authz: authzService }));
protectedApi.route(
  "/",
  createJobRoutes(jobService, db, orchestrator, {
    authz: authzService,
    defaultRunBase: config.WORKFLOW_RUN_BASE,
    jobLogs: jobLogsService,
    jobLogAccessAudit: jobLogAccessAuditor,
    governance: licenseRuntimeGovernance,
  }),
);
protectedApi.route("/", createPreferenceRoutes(preferenceService, db, { authz: authzService }));
protectedApi.route("/", createQueueRoutes(queueRegistry, db, { authz: authzService }));
// placement-preview endpoint (POST /api/scheduler/preview-placement).
// Reuses the same orchestrator instance as the dispatch path, so preview
// stays consistent with real placement.
protectedApi.route("/", createSchedulerRoutes(orchestrator, db, { authz: authzService }));
protectedApi.route("/", createAuditLogRoutes(db, { authz: authzService }));
protectedApi.route(
  "/",
  createStorageRoutes({
    db,
    service: storageQuotaService,
    clusterFileRootService,
    authz: authzService,
  }),
);
// admin SSO config routes (platform_admin only). Mounted under
// the protected API so the auth middleware fills `c.var.user` first.
protectedApi.route(
  "/",
  createAdminSsoRoutes(db, {
    secretWrappingKey: ssoSecretWrappingKey,
    allowInsecureIssuer: config.NODE_ENV !== "production",
    authz: authzService,
  }),
);
protectedApi.route("/", createAdminFileTransferAuditConfigRoutes(db, { authz: authzService }));
// CP-admin SSH credential vault routes (platform_admin only).
protectedApi.route(
  "/",
  createAdminSshCredentialRoutes(db, {
    secretWrappingKey: ssoSecretWrappingKey,
    authz: authzService,
  }),
);
// live SSH session monitoring + force-disconnect (platform_admin).
protectedApi.route("/", createAdminSshSessionRoutes(db, sshGateway, { authz: authzService }));
protectedApi.route(
  "/",
  createAdminDesensitizeRoutes(db, {
    exportKey: config.DESENSITIZE_EXPORT_KEY,
    authz: authzService,
  }),
);
protectedApi.route(
  "/",
  createTerminalRoutes(terminalService, {
    dispatcher,
    shellExecRegistry,
    authz: authzService,
    resolveAgentProviderOrg: createAgentProviderOrgResolver(db),
  }),
);
protectedApi.route(
  "/",
  createFileRoutes(fileService, {
    clusterFileRoots: config.CLUSTER_FILE_STATIC_ROOTS,
    clusterFileRootService,
    netdriveTransferSource: config.NETDRIVE_ENABLED
      ? {
          getFile: (ownerId, fileId) =>
            netdriveServiceForWorkflowOutputs?.getFile(ownerId, fileId) ?? Promise.resolve(null),
          getFileById: (fileId) =>
            netdriveServiceForWorkflowOutputs?.getFileById(fileId) ?? Promise.resolve(null),
          findFilesByPath: (ownerId, path, limit) =>
            netdriveServiceForWorkflowOutputs?.findFilesByPath(ownerId, path, limit) ??
            Promise.resolve([]),
        }
      : undefined,
    resolveAgentProviderOrg: createAgentProviderOrgResolver(db),
    authz: authzService,
    auditRootPolicyChange: async ({ actorUserId, rootId, changedAt, transfer }) => {
      await writeAudit(db, {
        actor: actorUserId,
        action: "file_transfer.root_policy_changed_during_run",
        target: transfer.id,
        diff: {
          after: {
            rootId,
            rootRevision: transfer.clusterRootRevision,
            changedAt,
            continuesRunning: true,
          },
        },
      });
    },
  }),
);
// NetDrive (PRD F18). Only mounted when NETDRIVE_ENABLED=true and
// the MinIO env is fully set; otherwise the legacy in-memory FileService
// continues to power the /api/files mock surface. Health-check failure aborts
// startup loudly so a misconfigured deployment fails fast.
if (config.SSH_SESSION_RECORDING && !config.NETDRIVE_ENABLED) {
  logger.warn(
    "SSH_SESSION_RECORDING=true but NETDRIVE_ENABLED=false — recording needs the MinIO backend and stays OFF",
  );
}
if (!(config.SSH_SESSION_RECORDING && config.NETDRIVE_ENABLED)) {
  protectedApi.get("/admin/ssh-recordings", (c) => c.json({ enabled: false, recordings: [] }));
}
let federationResults: FederationResultTransport | undefined;
let federationResultWorker: FederationResultWorker | undefined;
let federationInputStorageBackend: FederationInputStorageBackend | undefined;
let federationInputDownloads:
  | import("./federation/download-credential").FederationDownloadStorage
  | undefined;
let federationResultDownloads:
  | import("./federation/results").FederationResultDownloadStorage
  | undefined;
if (config.NETDRIVE_ENABLED) {
  const minioCfg = loadMinioConfigFromEnv({
    ...process.env,
    DATA_MARKET_STAGING_BUCKET: config.DATA_MARKET_STAGING_BUCKET,
    DATA_MARKET_IMMUTABLE_BUCKET: config.DATA_MARKET_IMMUTABLE_BUCKET,
  });
  const minioBackend = await createRealMinioBackend(minioCfg);
  federationInputStorageBackend = minioBackend;
  if (config.FEDERATION_ENABLED && config.FEDERATION_INPUT_DOWNLOAD_ORIGINS.length)
    federationInputDownloads = {
      storage: minioBackend,
      allowedOrigins: config.FEDERATION_INPUT_DOWNLOAD_ORIGINS,
    };
  if (config.FEDERATION_ENABLED && config.FEDERATION_RESULT_DOWNLOAD_ORIGINS.length)
    federationResultDownloads = {
      storage: minioBackend,
      allowedOrigins: config.FEDERATION_RESULT_DOWNLOAD_ORIGINS,
    };
  if (
    config.FEDERATION_ENABLED &&
    federationOutbound &&
    config.FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS.length &&
    config.FEDERATION_RESULT_DOWNLOAD_ORIGINS.length
  ) {
    const storage = new FederationResultStorage(
      federationOutbound.resultImports,
      federationOutbound.results,
      minioBackend,
      {
        sourceOrigins: config.FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS,
        destinationOrigins: config.FEDERATION_RESULT_DOWNLOAD_ORIGINS,
      },
    );
    federationResults = new FederationResultTransport(
      federationOutbound.resultImports,
      storage,
      dispatcher,
    );
    federationResultWorker = new FederationResultWorker(
      federationOutbound.resultImports,
      storage,
      federationResults,
    );
  }
  await minioBackend.healthCheck();
  await minioBackend.assertDataMarketStagingSafety();
  await minioBackend.assertDataMarketImmutability();
  logger.info(
    {
      endpoint: minioCfg.endpoint,
      netdriveBucket: minioCfg.bucket,
      dataMarketStagingBucket: minioCfg.dataMarketStagingBucket,
      dataMarketImmutableBucket: minioCfg.dataMarketImmutableBucket,
    },
    "NetDrive backend healthy — mounting /api/netdrive",
  );
  // SSH session recording reuses the same MinIO backend. When
  // enabled, capture transcripts and expose platform_admin retrieval.
  if (config.SSH_SESSION_RECORDING) {
    sshGateway.setRecordSink(
      makeObjectStoreRecordingSink(minioBackend, (meta) =>
        insertRecordingRow(db, meta, {
          authz: authzService,
          resolveActorUserId: resolveRecordingActorUserId,
        }),
      ),
    );
    protectedApi.route(
      "/",
      createAdminSshRecordingRoutes(db, minioBackend, { authz: authzService }),
    );
    logger.info("SSH session recording enabled — transcripts upload to object storage");
    // hourly retention sweep of recordings older than the cutoff.
    if (config.SSH_RECORDING_RETENTION_DAYS > 0) {
      const retentionMs = config.SSH_RECORDING_RETENTION_DAYS * 86_400_000;
      setInterval(() => {
        sweepOldRecordings(db, minioBackend, new Date(Date.now() - retentionMs), {
          authz: authzService,
          resolveActorUserId: resolveRecordingActorUserId,
        })
          .then((n) => {
            if (n > 0) logger.info({ pruned: n }, "Pruned expired SSH recordings");
          })
          .catch((err) => logger.error({ err }, "SSH recording retention sweep failed"));
      }, 3_600_000).unref?.();
      logger.info(
        { retentionDays: config.SSH_RECORDING_RETENTION_DAYS },
        "SSH recording retention enabled",
      );
    }
  }
  const netdriveService = new NetDriveService(db, minioBackend, {
    commitSecret: config.JWT_SECRET,
    multipartTtlSec: config.NETDRIVE_MULTIPART_TTL_SEC,
    multipartPartSize: config.NETDRIVE_MULTIPART_PART_SIZE_MB * 1024 * 1024,
    quotaGuard: (ownerId, path, size) =>
      storageQuotaService.assertCloudWriteAllowed(ownerId, path, size),
  });
  const mintAuthorizedNetDriveDownload = createAuthorizedNetDriveDownloadMint({
    service: netdriveService,
    authz: authzService,
    resolveActor: async (actorUserId) => {
      const [actor] = await db
        .select({ email: users.email, role: users.role })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1);
      return actor
        ? {
            email: actor.email,
            isPlatformAdmin: actor.role === "platform_admin" || actor.role === "super_admin",
          }
        : null;
    },
  });
  dataMarketUploadPort = new DataMarketObjectUploadService(
    new PgDataMarketObjectUploadRepository(db, minioBackend.dataMarketImmutableBucket),
    minioBackend,
    { immutableRetentionDays: config.DATA_MARKET_IMMUTABLE_RETENTION_DAYS },
  );
  const dataDeliveryResolver = new DataDeliveryResolver(db, minioBackend, {
    verifyAccess: (input) => dataPrerequisiteRepository.verifyAccess(input),
  });
  federationDataDispatch = new FederationDataDispatch(db, minioBackend, async (key, versionId) => {
    const expiresAt = Date.now() + 60_000;
    return {
      sourceUrl: await minioBackend.presignDownload(key, 60, undefined, versionId),
      expiresAt,
    };
  });
  orchestrator.setDataDeliveryResolver((input) => dataDeliveryResolver.resolveForDispatch(input));
  if (sandboxManifestSigner) {
    const restrictedSandboxDeliveryBinder = new RestrictedSandboxDeliveryBinder(
      sandboxManifestSigner,
    );
    orchestrator.setRestrictedSandboxDeliveryBinder((manifest, deliveries) =>
      restrictedSandboxDeliveryBinder.bind(manifest, deliveries),
    );
  }
  netdriveServiceForWorkflowOutputs = netdriveService;
  protectedApi.route(
    "/",
    createNetDriveRoutes({ db, service: netdriveService, authz: authzService }),
  );
  // Wire workflow input staging through NetDrive presigned downloads. Reuses the
  // FileTransferRequest cloud_to_cluster subsystem to push each input file onto
  // the placed agent before the job is dispatched.
  const stageOne = createFileStager({
    dispatcher,
    transferRegistry,
    mintDownloadUrl: mintAuthorizedNetDriveDownload,
    newTransferId: () => crypto.randomUUID(),
  });
  orchestrator.setInputStager(({ jobId, workflowRunId, agentId, actorUserId, workingDir, files }) =>
    stageWorkflowInputs(workingDir, files, (file, targetPath) =>
      stageOne(agentId, actorUserId, file, targetPath, { jobId, workflowRunId }),
    ),
  );
  orchestrator.setInputUrlResolver(
    async ({ jobId, workflowRunId, actorUserId, files, federation }) =>
      Promise.all(
        files.map(async (file) => {
          const snapshot = federation
            ? await netdriveService.getFile(actorUserId, file.fileMetadataId)
            : undefined;
          if (federation && !snapshot)
            throw new Error("Federation NetDrive input must belong to its execution identity");
          const { downloadUrl, expiresAt } = await mintAuthorizedNetDriveDownload(
            actorUserId,
            file.fileMetadataId,
            {
              jobId,
              workflowRunId,
              netdriveFileIds: [file.fileMetadataId],
            },
          );
          return {
            ...file,
            sourceUrl: downloadUrl,
            ...(snapshot
              ? {
                  netdriveInput: true,
                  expectedSha256: snapshot.sha256,
                  expectedSizeBytes: snapshot.size,
                  deliveryLeaseId: crypto.randomUUID(),
                  deliveryLeaseExpiresAtUnixMs: Date.parse(expiresAt),
                }
              : {}),
          };
        }),
      ),
  );
  transferRunner = new TransferRunner({
    db,
    dispatcher,
    netdriveService,
    transferRegistry,
    authz: authzService,
  });
  fileService.attachRunner(transferRunner);
}
const dataMarketService = new DataMarketService({
  repository: new PgDataMarketRepository(db),
  uploadPort: dataMarketUploadPort,
  dataScanCoordinator,
  deliveryRevoker: {
    revoke: (input) =>
      revokeDataDeliveryJobs({
        db,
        dispatcher,
        assetId: input.assetId,
        versionId: input.versionId,
        reasonCode: input.reasonCode,
      }),
  },
  grantRevocationCoordinator: dataGrantRevocationCoordinator,
  grantProjector: authzService,
  audit: {
    async record(input) {
      await writeAudit(db, {
        actor: input.actor,
        action: input.action,
        target: input.target,
        diff: { before: input.before, after: input.after },
      });
    },
  },
  authz: {
    async check({ actor, asset, permission, localAllowed }) {
      if (authzService.mode === "off") return localAllowed;
      const spiceAllowed = await authzService.check({
        resource: { type: "data_asset", id: asset.id },
        permission,
        subject: { type: "user", id: actor.userId },
      });
      return authzService.mode === "enforce" ? spiceAllowed : localAllowed;
    },
  },
});
protectedApi.route("/", createDataMarketRoutes({ service: dataMarketService }));
protectedApi.route("/", createAdminDataMarketRoutes(dataMarketService));
// software governance REST surface (PRD F19). org_admin or above.
protectedApi.route(
  "/",
  createSoftwareRoutes({
    db,
    installedRegistry,
    policyStore,
    policyPusher,
    dispatcher,
    availability: softwareAvailability,
    authz: authzService,
  }),
);
protectedApi.route(
  "/",
  createSandboxScriptRoutes({
    db,
    authz: authzService,
    submitTestRun: ({ yaml, submittedBy, role, plannerMode, mappingId, authorizeRun }) =>
      workflowAsyncRunner.submit({
        yaml,
        submittedBy,
        role,
        authorizeRun,
        placementConfig: WorkflowPlacementConfigSchema.parse({
          plannerMode,
          defaultExecutionIdentity: mappingId
            ? { type: "MappedAccount", mappingId }
            : { type: "MappedAuto" },
        }),
      }),
  }),
);
protectedApi.route("/", createSandboxAccountRoutes({ db, authz: authzService }));
protectedApi.route("/", createSandboxPolicyRoutes({ db, service: sandboxPolicyService }));
// CP Console REST surface (mounted under /api/cp). Tenant
// scope is enforced by the `cpRbac` middleware inside the router.
protectedApi.route(
  "/cp",
  buildCpRouter({
    consoleService: cpConsoleService,
    availability: softwareAvailability,
    softwareOperations,
    agentRegistration: agentRegistrationService,
    agentCerts: certService,
    authz: authzService,
    dataMarket: dataMarketService,
  }),
);
// Metering REST surface. Routes themselves carry the
// `/metering/*` prefix so the registration target is `/`.
protectedApi.route(
  "/",
  buildMeteringRouter({
    service: meteringService,
    webhookRepo,
    workflowAttribution: meteringWorkflowAttribution,
    authz: authzService,
  }),
);
protectedApi.route(
  "/interconnect",
  createInterconnectRoutes(new InterconnectService(db), authzService),
);
protectedApi.route(
  "/compute-providers",
  createComputeProviderRoutes(new ComputeProviderService(db), authzService),
);

const federationMaterialExchange =
  federationSigningKey && federationSender && federationPreparation
    ? new FederationMaterialExchange(
        db,
        federationSigningKey,
        federationSender,
        federationPreparation,
        federationAssets,
      )
    : undefined;
const federationInputImports =
  federationPreparation && federationMaterialExchange
    ? new FederationInputImports(db, federationPreparation, federationMaterialExchange)
    : undefined;
const federationInputTransfers =
  federationPreparation && federationInputImports
    ? new FederationInputTransfers(db, federationPreparation, federationInputImports)
    : undefined;
const federationInputReader =
  federationInputTransfers && federationSigningKey && federationSender
    ? new FederationInputReader(
        db,
        federationSigningKey,
        federationSender,
        federationInputTransfers,
      )
    : undefined;
const federationInputStorage =
  federationInputTransfers && federationInputStorageBackend
    ? new FederationInputStorage(federationInputTransfers, federationInputStorageBackend, {
        grants:
          federationInputReader &&
          config.FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS.length &&
          config.FEDERATION_INPUT_DOWNLOAD_ORIGINS.length
            ? {
                reader: federationInputReader,
                sourceOrigins: config.FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS,
                destinationOrigins: config.FEDERATION_INPUT_DOWNLOAD_ORIGINS,
              }
            : undefined,
      })
    : undefined;
const federationInputs =
  config.FEDERATION_ENABLED &&
  federationInputTransfers &&
  federationInputStorage &&
  config.FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS.length &&
  config.FEDERATION_INPUT_DOWNLOAD_ORIGINS.length
    ? new FederationInputTransport(federationInputTransfers, federationInputStorage, dispatcher)
    : undefined;
const federationInputWorker =
  federationInputTransfers &&
  federationInputs &&
  federationPreparation &&
  federationInputImports &&
  federationMaterialExchange &&
  federationInputStorageBackend
    ? new FederationInputWorker(
        federationInputTransfers,
        federationInputs,
        new FederationInputPublication(
          db,
          federationPreparation,
          federationInputImports,
          federationMaterialExchange,
          federationInputStorageBackend,
        ),
      )
    : undefined;

if (federationInputTransfers)
  protectedApi.route(
    "/",
    createAdminFederationStorageRoutes(federationInputTransfers, authzService),
  );
app.route("/api", protectedApi);
// NOTE: any future PUBLIC routes must be registered BEFORE app.route("/api", protectedApi)
// to avoid being shadowed by the auth middleware on protectedApi.

// connectRPC server for Agent bidirectional streaming.
const grpcDeps = {
  agentManager,
  jobService,
  logger,
  dispatcher,
  installedRegistry,
  softwareOperations,
  policyStore,
  policyPusher,
  metricsRecorder,
  queueInventory,
  queueObservability,
  sshGateway,
  shellExecRegistry,
  jobLogsService,
  federationAccounting,
  transferRegistry,
  jobCompletionRegistry,
  federationResults,
  federationInputs,
  partUrlMinter: transferRunner,
  sandboxArtifactRelease: sandboxArtifactReleaseService,
  dataScanCoordinator,
  dataDeliveryRevocations: dataDeliveryRevocationOutbox,
  jobCancellations: jobCancellationOutbox,
  jobDispatches: jobDispatchOutbox,
  jobWorkRootReleases: jobWorkRootReleaseOutbox,
};

// wrap with the Agent certificate fingerprint guard. MTLS_MODE
// is the production selector; MTLS_REQUIRED remains a compatibility alias.
const mtlsMode = config.MTLS_MODE ?? (config.MTLS_REQUIRED ? "direct" : "off");
const mtlsEnabled = mtlsMode !== "off";
if (!mtlsEnabled && config.NODE_ENV !== "development" && config.NODE_ENV !== "test") {
  logger.warn(
    { nodeEnv: config.NODE_ENV, mtlsMode },
    "MTLS_MODE=off in a non-dev environment — Agent ↔ Server gRPC stream is UNAUTHENTICATED. This is acceptable only for local debugging; production deployments MUST set MTLS_MODE=direct or trusted-proxy.",
  );
}
if (mtlsMode === "trusted-proxy" && config.MTLS_TRUSTED_PROXY_CIDRS.trim().length === 0) {
  throw new Error("MTLS_TRUSTED_PROXY_CIDRS is required when MTLS_MODE=trusted-proxy");
}
const grpcHandler = createGrpcConnectNodeHandler(grpcDeps, {
  enabled: mtlsEnabled,
  fingerprintHeader: config.MTLS_HEADER_FINGERPRINT,
  lookup: agentCertLookup,
  useVerifiedPeerCertificate: mtlsMode === "direct",
  ...(mtlsMode === "trusted-proxy" ? { trustedProxyCidrs: config.MTLS_TRUSTED_PROXY_CIDRS } : {}),
});

// idleTimeout: 0 disables the default 10s idle timeout so long-lived agent
// gRPC streams aren't aborted between heartbeats. Verified on Bun 1.3.13.
// If a future Bun upgrade changes the semantic of 0, the e2e slice test
// (test/e2e/cli-to-slurm.test.ts) will catch the regression.
const grpcServer =
  mtlsMode === "direct"
    ? createSecureServer(
        {
          cert: await readRequiredGrpcTlsFile(
            config.SERVER_GRPC_TLS_CERT_FILE,
            "SERVER_GRPC_TLS_CERT_FILE",
          ),
          key: await readRequiredGrpcTlsFile(
            config.SERVER_GRPC_TLS_KEY_FILE,
            "SERVER_GRPC_TLS_KEY_FILE",
          ),
          ca: ca.certPem,
          requestCert: true,
          rejectUnauthorized: true,
        },
        grpcHandler,
      )
    : createServer(grpcHandler);
attachGrpcTransportErrorHandlers(grpcServer, logger, { secure: mtlsMode === "direct" });
grpcServer.setTimeout(0);
grpcServer.listen(config.SERVER_GRPC_PORT);
logger.info(
  { grpcPort: config.SERVER_GRPC_PORT, mtlsMode, mtlsEnabled },
  "Server gRPC server started",
);

async function readRequiredGrpcTlsFile(
  path: string | undefined,
  configName: string,
): Promise<string> {
  if (!path) {
    throw new Error(`${configName} is required when MTLS_MODE=direct`);
  }
  return readFile(path, "utf8");
}

const federationIngress = await startFederationIngress(
  db,
  config,
  federationSigningKey,
  federationResultDownloads,
  federationOutbound,
  federationInputDownloads,
);
const federationPreparationWorker = federationPreparation
  ? new FederationPreparationWorker(
      db,
      federationPreparation,
      new FederationExecutionBindingService(db, federationPreparation),
      async (runId) => {
        if (!federationDispatchAuthorization)
          throw new WorkflowExecutionInterrupted(
            "Federation workflow authorization is unavailable",
          );
        const binding = await loadFederationWorkflowBinding(db, runId);
        if (!binding) throw new Error("Federation workflow binding is unavailable");
        await registerWorkflowAuthorization(
          authzService,
          runId,
          binding.snapshot.identity.userId,
          binding.snapshot.identity.orgId,
        );
        await placementPlanService.prepare(
          runId,
          binding.snapshot.workflow,
          WorkflowPlacementConfigSchema.parse({}),
        );
        return queueFederationWorkflow(db, federationDispatchAuthorization, runId);
      },
      federationMaterialExchange
        ? async (id) => {
            await federationMaterialExchange.ensure(id);
            await federationInputImports?.ensure(id);
          }
        : undefined,
      federationInputImports
        ? async () => {
            await federationInputImports.sweep();
            if (federationInputStorage) await federationInputStorage.cleanup();
            else await federationInputTransfers?.expire();
          }
        : undefined,
    )
  : undefined;
federationPreparationWorker?.start();
const federationOutboundWorker = federationOutbound
  ? new FederationOutboundWorker(federationOutbound)
  : undefined;
federationOutboundWorker?.start();
federationResultWorker?.start();
federationInputWorker?.start();
const federationExecutionMonitor = new FederationExecutionMonitor(
  db,
  federationDispatchAuthorization,
  workflowAsyncRunner,
);
federationExecutionMonitor.start();
const federationCancellationMonitor = new FederationCancellationMonitor(
  db,
  workflowAsyncRunner,
  (runId) =>
    cancelWorkflowJobs(
      runId,
      workflowRegistry,
      jobService,
      jobCancellationOutbox,
      jobCompletionRegistry,
    ),
);
federationCancellationMonitor.start();
const federationAttestationWorker =
  federationAttestation && config.FEDERATION_ATTESTATION_SOCKET_PATH
    ? new FederationAttestationWorker(federationAttestation)
    : undefined;
federationAttestationWorker?.start();
const federationCommercialWorker = federationCommercial
  ? new FederationCommercialWorker(
      federationCommercial,
      federationUsage,
      federationUsageExchange,
      federationAccounting,
      federationMarket,
    )
  : undefined;
federationCommercialWorker?.start();
logger.info({ port: config.SERVER_PORT }, "Server starting");

const httpTrustedProxyCidrs = parseTrustedProxyCidrs(config.HTTP_TRUSTED_PROXY_CIDRS);

// start the metering rollup cron. Failures during the first
// tick are caught and logged inside the cron itself, so this `void` is
// safe — we don't want to block bootstrap on a transient DB hiccup.
void meteringCron.start();

// `websocket` from hono/bun bridges Bun's `Bun.serve.websocket` handler to
// the `upgradeWebSocket` calls inside route definitions. The default export
// is consumed by Bun's runtime when this file is the entrypoint.
export default {
  port: config.SERVER_PORT,
  hostname: "0.0.0.0",
  fetch(request: Request, server: Bun.Server<unknown>) {
    const headers = new Headers(request.headers);
    headers.delete(RESOLVED_CLIENT_IP_HEADER);
    const clientIp = resolveHttpClientIp({
      socketPeer: server.requestIP(request)?.address,
      xForwardedFor: request.headers.get("x-forwarded-for") ?? undefined,
      trustedProxyCidrs: httpTrustedProxyCidrs,
    });
    if (clientIp) headers.set(RESOLVED_CLIENT_IP_HEADER, clientIp);
    return app.fetch(new Request(request, { headers }));
  },
  websocket,
};

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Server shutting down");
  try {
    grpcServer.close();
    await federationCancellationMonitor.stop();
    await federationExecutionMonitor.stop();
    await workflowAsyncRunner.stop();
    await federationIngress?.stop(true);
    await federationPreparationWorker?.stop();
    await federationOutboundWorker?.stop();
    await federationInputWorker?.stop();
    await federationResultWorker?.stop();
    await federationAttestationWorker?.stop();
    await federationCommercialWorker?.stop();
    await jobDispatchOutbox.stop();
    await jobCancellationOutbox.stop();
    fileService.shutdown();
    // Stop the metering rollup cron so an in-flight tick can drain
    // before exit; the cron internally catches and logs errors so this
    // call always resolves.
    await meteringCron.stop();
    // Allow in-flight requests up to 100ms to drain
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
