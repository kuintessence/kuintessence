import { readFile } from "node:fs/promises";
import { createSecureServer, createServer } from "node:http2";
import { posix as posixPath } from "node:path";
import {
  createPgDb,
  type PgDb,
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
import {
  AgentDispatcher,
  JobCancellationOutbox,
  JobWorkRootReleaseOutbox,
} from "./grpc/dispatcher";
import { createGrpcConnectNodeHandler } from "./grpc/server";
import { attachGrpcTransportErrorHandlers } from "./grpc/transport-errors";
import { authMiddleware } from "./middleware/auth";
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
import { createAdminFileTransferAuditConfigRoutes } from "./routes/admin-file-transfer-audit-config";
import { createAdminSshCredentialRoutes } from "./routes/admin-ssh-credentials";
import { createAdminSshRecordingRoutes } from "./routes/admin-ssh-recordings";
import { createAdminSshSessionRoutes } from "./routes/admin-ssh-sessions";
import { createAdminSsoRoutes } from "./routes/admin-sso";
import { createAgentRegistrationRoutes } from "./routes/agent-registration";
import { createAgentRoutes } from "./routes/agents";
import { createAuditLogRoutes } from "./routes/audit-log";
import { createAuthRoutes } from "./routes/auth";
import { buildCpRouter } from "./routes/cp";
import { createDataMarketRoutes } from "./routes/data-market";
import { dslRoutes } from "./routes/dsl";
import { createFileRoutes } from "./routes/files";
import { healthRoutes } from "./routes/health";
import { createJobRoutes } from "./routes/jobs";
import { createMeCapabilityRoutes } from "./routes/me-capabilities";
import { buildMeteringRouter, DrizzleWebhookRepository } from "./routes/metering";
import { createMetricsRoutes, recordRequest } from "./routes/metrics";
import { createNetDriveRoutes } from "./routes/netdrive";
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
import { createWorkflowPlacementBuilder } from "./services/workflow-placement-builder";
import {
  InstalledRegistry,
  PgAgentMetricsRecorder,
  PolicyPusher,
  PolicyStore,
  SoftwareOperationService,
} from "./software-governance";
import { createRealMinioBackend, loadMinioConfigFromEnv } from "./storage/minio-client";
import { WorkflowAsyncRunner } from "./workflow/async-runner";
import { createDatasetPreflight } from "./workflow/dataset-preflight";
import { createDbPackageStore } from "./workflow/db-package-store";
import { WorkflowDraftService } from "./workflow/draft-service";
import { createFileStager } from "./workflow/file-stager";
import { JobCompletionRegistry } from "./workflow/job-completion-registry";
import { createJobSubmitter } from "./workflow/job-submitter";
import {
  PgWorkflowNamedReferenceRepository,
  WorkflowNamedReferenceResolver,
} from "./workflow/named-reference-resolver";
import { createPackageResolver } from "./workflow/package-resolver";
import { parseWorkflowYaml } from "./workflow/parser";
import { WorkflowRunRegistry } from "./workflow/run-registry";
import { createWorkflowRunner } from "./workflow/runner";
import { stageWorkflowInputs } from "./workflow/stage-inputs";

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
const softwareOperations = new SoftwareOperationService(db, dispatcher, installedRegistry);
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
  queueRegistry,
  computeHealth: {
    enforce: config.COMPUTE_HEALTH_ENFORCE,
    maxAgeSec: config.COMPUTE_HEALTH_MAX_AGE_SEC,
    maxFutureSkewSec: config.COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC,
  },
  db,
  softwareAvailability,
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
const workflowArtifactService = new WorkflowArtifactService(
  new PgArtifactStore(db),
  {
    persist: async ({ artifact, localReplica, ownerId }) => {
      if (!transferRunner || !netdriveServiceForWorkflowOutputs) {
        throw new Error("NetDrive is unavailable for durable Sandbox artifacts");
      }
      const safeDescriptor = artifact.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
      const target = `workflow-runs/${artifact.workflowRunId}/artifacts/${artifact.id}/${safeDescriptor}`;
      await waitForWorkflowOutputTransfer({
        transferId: crypto.randomUUID(),
        ownerId,
        source: localReplica.storageRef,
        target,
        agentId: localReplica.agentId,
        workflowRunId: artifact.workflowRunId,
      });
      const listed = await netdriveServiceForWorkflowOutputs.listFiles(ownerId, {
        prefix: target,
        limit: 1,
        offset: 0,
      });
      const file = listed.files.find((item) => item.path === target);
      if (!file || file.sha256 !== artifact.contentHash || file.size !== artifact.sizeBytes) {
        throw new Error("Persisted Sandbox artifact failed size/hash verification");
      }
      return { netdriveFileId: file.id, storageRef: target };
    },
  },
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
const jobCompletionRegistry = new JobCompletionRegistry();
const workflowPackageStore = createDbPackageStore(db);
const workflowPackageResolver = createPackageResolver(workflowPackageStore);
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

const validateWorkflowDatasetInputs = createDatasetPreflight({
  loadUsecasePackage: async (usecaseVersionId) =>
    (await workflowPackageStore.getById(usecaseVersionId))?.spec ?? null,
  assertUsecaseExecutionAccess: (input) =>
    assertUsecasePackageExecutionAccess(db, input.usecaseVersionId, input.requester),
  resolveWorkflowVersion,
  verifyAccess: (input) => dataPrerequisiteRepository.verifyAccess(input),
  validateUsecase: (input) => workflowDataSelectionValidator.validateUsecase(input),
});

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

const makeRunner = (
  submittedBy: string,
  userRole: RoleName,
  persistRun = true,
  activeRunId?: string,
  rawPlacementConfig?: WorkflowPlacementConfig,
  activeOrgId?: string | null,
) => {
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
    if (authzService.mode === "enforce") {
      await authzService.writeRelationships(authorizationTuples);
    }
    await authzService.enqueueMany(authorizationTuples);
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
          awaitCompletion: (jobId) =>
            jobCompletionRegistry.awaitCompletion(
              jobId,
              config.SERVER_JOB_COMPLETION_TIMEOUT_SEC * 1000,
            ),
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
  return createWorkflowRunner({
    // Persist runs for audit and visibility in `workflow list`.
    ...(persistRun
      ? {
          persistRun: (name, result, graph) =>
            workflowRegistry.recordRun(name, submittedBy, result, graph),
        }
      : {}),
    resolvePackage: workflowPackageResolver,
    resolveWorkflowVersion,
    ...(sandboxExecutor ? { executeScript: sandboxExecutor.execute.bind(sandboxExecutor) } : {}),
    submitJob: createJobSubmitter({
      prepare: async (spec) => {
        await assertWorkflowExecutionMembership({
          userId: submittedBy,
          orgId: activeOrgId ?? null,
        });
        if (!spec.usecasePackageId) return spec;
        await assertUsecasePackageExecutionAccess(db, spec.usecasePackageId, {
          userId: submittedBy,
          orgId: activeOrgId ?? null,
        });
        const row = await workflowPackageStore.getById(spec.usecasePackageId);
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
          ...(Object.keys(selectedDataInputs).length > 0 ? { dataInputs: selectedDataInputs } : {}),
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
        const job = await jobService.submit(
          {
            name: spec.name,
            ...(spec.usecasePackageId ? { usecasePackageId: spec.usecasePackageId } : {}),
            ...(spec.dataInputs ? { dataInputs: spec.dataInputs } : {}),
            command: spec.command,
            // Honour the node's declared requirements (mapped from
            // workflowDsl.Requirements); fall back to modest defaults.
            resources: {
              cpus: spec.resources?.cpus ?? 1,
              memoryMb: 1024,
              ...(spec.resources?.wallTimeSec != null
                ? { wallTimeSec: spec.resources.wallTimeSec }
                : {}),
            },
            envVars: spec.envVars,
            ...(spec.softwareRequirements
              ? { softwareRequirements: spec.softwareRequirements }
              : {}),
            inputStaging: spec.inputStaging,
            expectedOutputs: spec.expectedOutputs,
            fileOutputDescriptors: spec.fileOutputDescriptors,
            ...(spec.stdinText !== undefined ? { stdinText: spec.stdinText } : {}),
            ...(spec.schedulingStrategy ? { schedulingStrategy: spec.schedulingStrategy } : {}),
          },
          submittedBy,
          {
            ...(activeOrgId !== undefined ? { orgId: activeOrgId } : {}),
            trustedMaterialization: true,
            ...(activeRunId ? { workflow: { runId: activeRunId, nodeId: spec.nodeId } } : {}),
          },
        );
        // Stamp a per-job run directory so input staging, the job cwd, and
        // relative output collection all target the same place.
        if (config.WORKFLOW_RUN_BASE) {
          await jobService.setWorkingDir(job.id, `${config.WORKFLOW_RUN_BASE}/${job.id}`);
        }
        await authorizeJobSubmission({
          jobId: job.id,
          orgId: job.orgId,
          queueId: job.queueId,
        });
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
          if (!result.dispatched) {
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
          const errorMessage = err instanceof Error ? err.message : "Workflow job dispatch failed.";
          const failedJob = await jobService
            .updateStatus(jobId, "failed", undefined, undefined, errorMessage)
            .catch((updateErr) => {
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
      awaitCompletion: (jobId) =>
        jobCompletionRegistry.awaitCompletion(
          jobId,
          config.SERVER_JOB_COMPLETION_TIMEOUT_SEC * 1000,
        ),
      collectFiles: (jobId, spec, collected) =>
        collectWorkflowOutputFiles({
          jobId,
          spec,
          collected,
          ownerId: submittedBy,
          workflowRunId: activeRunId,
        }),
    }),
  });
};
const workflowAsyncRunner = new WorkflowAsyncRunner({
  registry: workflowRegistry,
  resolveNamedReferences: (workflow, principal) =>
    namedReferenceResolver.resolve(workflow, principal),
  validateWorkflow: validateWorkflowDatasetInputs,
  assertExecutionPrincipal: assertWorkflowExecutionMembership,
  preparePlacement: (runId, workflow, placementConfig) =>
    placementPlanService.prepare(runId, workflow, placementConfig),
  makeRunner: (submittedBy, role, runId, placementConfig, orgId) =>
    makeRunner(submittedBy, role, false, runId, placementConfig, orgId),
  awaitCheckpointPersistence: (runId) => workflowArtifactService.awaitCheckpointPersistence(runId),
  markArtifactsTerminal: (runId) => workflowArtifactService.markWorkflowTerminal(runId),
  cancelSubmittedJobs: async (runId) => {
    const run = await workflowRegistry.getById(runId);
    const stepJobs = run?.stepJobs ?? {};
    const results = await Promise.allSettled(
      Object.values(stepJobs).map(async (jobId) => {
        const job = await jobService.getById(jobId);
        if (!job || job.status === "completed" || job.status === "failed") return;
        const cancelled = await jobService.updateStatus(jobId, "cancelled");
        if (cancelled.agentId) {
          await orchestrator.cancelJob(cancelled.agentId, jobId, cancelled.revokedEpoch);
          await jobCancellationOutbox.waitForAcknowledgement(jobId, cancelled.revokedEpoch);
        }
        jobCompletionRegistry.complete(jobId, { status: "cancelled", collected: {} });
      }),
    );
    const failures: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        failures.push(result.reason);
        logger.warn(
          { err: result.reason, jobId: Object.values(stepJobs)[index], runId },
          "Failed to cancel submitted workflow job",
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Workflow ${runId} job cancellation did not converge`);
    }
  },
});

async function collectWorkflowOutputFiles(input: {
  jobId: string;
  spec: JobSubmission;
  collected: Record<string, string>;
  ownerId: string;
  workflowRunId?: string;
}): Promise<Record<string, usecase.FileInputValue>> {
  const job = await jobService.getById(input.jobId);
  if (!job?.workingDir || !job.agentId) {
    logger.warn({ jobId: input.jobId }, "Workflow output files cannot be published");
    return {};
  }
  const outputJob = { workingDir: job.workingDir, agentId: job.agentId };
  try {
    if (!transferRunner || !netdriveServiceForWorkflowOutputs) {
      return {};
    }
    if (job.restrictedNoEgress) {
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
      if (file) {
        files[out.descriptor] = {
          fileMetadataId: file.id,
          fileMetadataName: file.name,
        };
      }
    }
    return files;
  } finally {
    await jobWorkRootReleaseOutbox.enqueue(job.agentId, input.jobId);
    await jobWorkRootReleaseOutbox.redeliver(job.agentId);
  }
}

async function publishBatchWorkflowOutputFiles(input: {
  jobId: string;
  out: { descriptor: string; path: string; isBatch: boolean };
  collected: Record<string, string>;
  ownerId: string;
  workflowRunId?: string;
  job: { workingDir: string; agentId: string };
}): Promise<usecase.FileValue[] | undefined> {
  const pathsJson = input.collected[usecase.batchOutputPathsDescriptor(input.out.descriptor)];
  if (!pathsJson) {
    logger.warn(
      { jobId: input.jobId, descriptor: input.out.descriptor },
      "Batched workflow output lacks path metadata; cannot publish artifacts",
    );
    return undefined;
  }
  const paths = parseBatchOutputPaths(pathsJson);
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
    if (file) {
      files.push({ fileMetadataId: file.id, fileMetadataName: file.name });
    }
  }
  return files;
}

function parseBatchOutputPaths(pathsJson: string): string[] {
  try {
    const parsed = JSON.parse(pathsJson);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
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
  .catch((err) => logger.error({ err }, "Failed to recover interrupted workflow runs"));
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
protectedApi.route("/", createActiveOrganizationRoutes(db));
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
if (config.NETDRIVE_ENABLED) {
  const minioCfg = loadMinioConfigFromEnv({
    ...process.env,
    DATA_MARKET_STAGING_BUCKET: config.DATA_MARKET_STAGING_BUCKET,
    DATA_MARKET_IMMUTABLE_BUCKET: config.DATA_MARKET_IMMUTABLE_BUCKET,
  });
  const minioBackend = await createRealMinioBackend(minioCfg);
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
  orchestrator.setInputUrlResolver(async ({ jobId, workflowRunId, actorUserId, files }) =>
    Promise.all(
      files.map(async (file) => {
        const { downloadUrl } = await mintAuthorizedNetDriveDownload(
          actorUserId,
          file.fileMetadataId,
          {
            jobId,
            workflowRunId,
            netdriveFileIds: [file.fileMetadataId],
          },
        );
        return { ...file, sourceUrl: downloadUrl };
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
protectedApi.route("/", createSandboxAccountRoutes({ db }));
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
  transferRegistry,
  jobCompletionRegistry,
  partUrlMinter: transferRunner,
  sandboxArtifactRelease: sandboxArtifactReleaseService,
  dataScanCoordinator,
  dataDeliveryRevocations: dataDeliveryRevocationOutbox,
  jobCancellations: jobCancellationOutbox,
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
