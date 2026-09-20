import { mkdir } from "node:fs/promises";
import { createSqliteDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { realSpawner, type SandboxJobSpec, type Spawner } from "./adapters/base";
import { detectScheduler } from "./adapters/detect";
import type { PbsProAdapterDeps } from "./adapters/pbs-pro";
import type { SlurmAdapterDeps } from "./adapters/slurm";
import { ContainerSpawner } from "./adapters/spawner-container";
import type { TorqueAdapterDeps } from "./adapters/torque";
import { ensureCertBundle } from "./auth/bootstrap";
import { createHttpEnrollmentClient } from "./auth/enrollment-client";
import { fingerprintOfPem } from "./auth/fingerprint";
import { loadAgentConfig } from "./config";
import {
  makeContainerGlobScanner,
  makeContainerMkdir,
  makeContainerReadOutput,
} from "./container-io";
import { DataDeliveryExecutor, LinuxBindReadonlyMountDriver } from "./data-market/data-delivery";
import { createCpLocalDataScanner, createCpLocalDataScanSigner } from "./data-market/data-scan";
import { AgentDataRoots } from "./data-market/local-data-security";
import { LicensedMaterialResolver } from "./licensed-material-resolver";
import {
  createOutputCollector,
  type GlobScanner,
  hostOutputReader,
  type OutputReader,
} from "./output-collector";
import { ActiveRemoteJobs } from "./queue/active-remote-jobs";
import { InboundAcks } from "./queue/inbound-acks";
import { JobCleanupIntents, JobRevocationTombstones } from "./queue/job-cleanup-intents";
import { OutboundQueue } from "./queue/outbound-queue";
import { releaseSandboxArtifacts } from "./sandbox/artifact-release";
import { buildSandboxCapability, refreshKubernetesSandboxCapability } from "./sandbox/capability";
import { SandboxDispatchProcessor } from "./sandbox/dispatch-processor";
import { downloadSandboxInput } from "./sandbox/input-downloader";
import {
  assertKubernetesSeccompProfileCurrent,
  attestKubernetesSeccompProfile,
  enforceKubernetesSeccompStartupBinding,
} from "./sandbox/kubernetes-seccomp-profile";
import { LocalSandboxAccountVerifier } from "./sandbox/local-account-verifier";
import { SandboxManifestVerifier } from "./sandbox/manifest-verifier";
import { SandboxReplayNonceStore } from "./sandbox/replay-nonce-store";
import {
  buildRestrictedExecutionProfile,
  validateRestrictedExecutionProfile,
} from "./sandbox/restricted-execution-profile";
import {
  attestSandboxRuntimeEnvironment,
  currentSandboxProcessIdentity,
} from "./sandbox/runtime-attestation";
import { removeSandboxRun, SandboxStager } from "./sandbox/stager";
import {
  type ClientFetchMtlsConfig,
  createServerClient,
  createServerReachabilityProbe,
} from "./server-client";
import { configureSpackMaterialClient, SpackManager } from "./spack";
import { IsolatedSpackInstallRunner } from "./spack/install-runner";
import { ManagedSpackInstallation } from "./spack/managed-installation";
import { SpackSourceAuditor } from "./spack/source-auditor";
import { SshHandler } from "./ssh";
import { AgentStream } from "./stream";

async function main() {
  const config = loadAgentConfig();
  const logger = createLogger("agent", config.LOG_LEVEL);
  logger.info({ agentId: config.AGENT_ID, site: config.AGENT_SITE_NAME }, "Agent starting");

  // Open local SQLite (initializes schema via runSqliteMigrations)
  const db = createSqliteDb(config.AGENT_DB_PATH);
  logger.info({ path: config.AGENT_DB_PATH }, "Local SQLite ready");

  // Persistent outbound spillover for offline windows. The heartbeat cap
  // bounds `outbound_heartbeat` so a long disconnect doesn't accumulate
  // arbitrarily many stale CPU samples to flood the Server on reconnect.
  const outboundQueue = new OutboundQueue(db, {
    maxQueuedHeartbeats: config.AGENT_MAX_QUEUED_HEARTBEATS,
  });
  const initialPending = await outboundQueue.pendingCount();
  logger.info(
    { pending: initialPending, maxQueuedHeartbeats: config.AGENT_MAX_QUEUED_HEARTBEATS },
    "Outbound queue ready",
  );

  // Persistent record of received DispatchJob deliveries that have not yet
  // been acked with a JobStatusReport. Closes the disconnect-mid-ack race.
  const inboundAcks = new InboundAcks(db);
  const initialPendingAcks = await inboundAcks.pendingInbound();
  if (initialPendingAcks.length > 0) {
    logger.info(
      { pending: initialPendingAcks.length },
      "Inbound dispatch acks owed from previous run — will replay on reconnect",
    );
  }
  const activeRemoteJobs = new ActiveRemoteJobs(db);
  const cleanupIntents = new JobCleanupIntents(db);
  const revocationTombstones = new JobRevocationTombstones(db);
  const dataRoots = new AgentDataRoots({
    datasetRoot: config.AGENT_DATASET_ROOT,
    managedRoots: config.AGENT_DATASET_ROOTS_JSON,
    jobWorkRoot: config.AGENT_JOB_WORK_ROOT,
    restrictedRoots: [config.AGENT_LICENSED_MATERIAL_ROOT],
  });
  await dataRoots.initialize();
  logger.info(
    { datasetRoot: config.AGENT_DATASET_ROOT, jobWorkRoot: config.AGENT_JOB_WORK_ROOT },
    "Data Market roots ready",
  );

  // Pick spawner based on config. The container test image has no sacct accounting.
  // Defense in depth: zod refine catches a missing AGENT_SLURM_CONTAINER_ID at
  // config-load time, but an explicit guard here narrows the type and surfaces
  // a clearer error if the schema ever drifts.
  let spawner: Spawner;
  let slurmDeps: SlurmAdapterDeps;
  let pbsProDeps: PbsProAdapterDeps;
  let torqueDeps: TorqueAdapterDeps;
  let outputReader: OutputReader;
  let globScanner: GlobScanner | undefined;
  let ensureWorkingDir: (path: string) => Promise<void>;
  if (config.AGENT_SPAWNER_BACKEND === "container") {
    const containerId = config.AGENT_SLURM_CONTAINER_ID;
    if (!containerId) {
      throw new Error(
        "AGENT_SPAWNER_BACKEND=container requires AGENT_SLURM_CONTAINER_ID to be set",
      );
    }
    spawner = new ContainerSpawner(containerId);
    const containerLogDir = "/var/tmp/kq-slurm-shared";
    const makeContainerDirectory = makeContainerMkdir(containerId);
    await makeContainerDirectory(containerLogDir);
    slurmDeps = {
      logDir: containerLogDir,
      terminalStatusBackend: "scontrol",
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    pbsProDeps = {
      logDir: containerLogDir,
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    torqueDeps = {
      logDir: containerLogDir,
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    outputReader = makeContainerReadOutput(containerId);
    globScanner = makeContainerGlobScanner(containerId);
    ensureWorkingDir = makeContainerDirectory;
  } else {
    spawner = realSpawner;
    const logDir = dataRoots.schedulerLogDir();
    slurmDeps = {
      logDir,
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    pbsProDeps = {
      logDir,
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    torqueDeps = {
      logDir,
      queueInventoryRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
      queueInventoryTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    };
    outputReader = hostOutputReader;
    ensureWorkingDir = async (path: string) => {
      await mkdir(path, { recursive: true });
    };
  }
  const readonlyMountDriver =
    config.AGENT_DATA_READONLY_MOUNT_DRIVER === "linux-bind"
      ? new LinuxBindReadonlyMountDriver(realSpawner)
      : undefined;
  const dataDeliveryExecutor = new DataDeliveryExecutor({
    roots: dataRoots,
    readonlyMountDriver,
  });
  const baseCollectOutputs = createOutputCollector(outputReader, logger, globScanner);
  const collectOutputs =
    process.env.NODE_ENV === "test" && config.AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR
      ? async (outputs: Parameters<typeof baseCollectOutputs>[0], workingDir: string) => {
          const descriptor = config.AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR;
          if (outputs.some((output) => output.descriptor === descriptor)) {
            throw new Error(`injected output collection failure for descriptor ${descriptor}`);
          }
          return baseCollectOutputs(outputs, workingDir);
        }
      : baseCollectOutputs;

  // Detect local scheduler
  let kubernetesSeccompProfile = await attestKubernetesSeccompProfile(config);
  const kubernetesSeccompProfileBound =
    kubernetesSeccompProfile.ready &&
    !!kubernetesSeccompProfile.localhostProfile &&
    !!kubernetesSeccompProfile.nodeName;
  const adapter = await detectScheduler({
    spawner,
    slurmDeps,
    pbsProDeps,
    torqueDeps,
    k8sDeps: {
      defaultImage: config.AGENT_K8S_DEFAULT_IMAGE,
      ...(kubernetesSeccompProfileBound &&
      kubernetesSeccompProfile.localhostProfile &&
      kubernetesSeccompProfile.nodeName
        ? {
            sandboxSeccompProfile: {
              localhostProfile: kubernetesSeccompProfile.localhostProfile,
              nodeName: kubernetesSeccompProfile.nodeName,
              assertCurrent: () =>
                assertKubernetesSeccompProfileCurrent(config, kubernetesSeccompProfile),
            },
          }
        : {}),
    },
  });
  if (config.AGENT_SPAWNER_BACKEND === "host" && adapter.type !== "kubernetes") {
    const schedulerLogDir = await dataRoots.prepareSchedulerLogDir();
    logger.info({ schedulerLogDir }, "Shared scheduler log directory ready");
  }
  logger.info({ type: adapter.type, version: adapter.version }, "Scheduler detected");

  const sandboxProcessIdentity = currentSandboxProcessIdentity();
  const selfAccountSandbox = config.AGENT_SANDBOX_EXECUTION_MODE === "self-account";
  const sandboxRuntimeAttestation = selfAccountSandbox
    ? await attestSandboxRuntimeEnvironment(config, adapter.type, spawner, sandboxProcessIdentity)
    : undefined;
  const sandboxRuntimeCache =
    sandboxRuntimeAttestation?.runtimeCache ?? config.AGENT_SANDBOX_RUNTIME_CACHE_JSON;
  const sandboxCapability = buildSandboxCapability(
    config,
    adapter.type,
    sandboxProcessIdentity,
    sandboxRuntimeAttestation,
    kubernetesSeccompProfile,
  );
  logger.info(
    {
      enabled: sandboxCapability.enabled,
      readiness: sandboxCapability.readiness,
      executionMode: sandboxCapability.executionMode,
      rootMode: sandboxCapability.rootMode,
      missingRequirements: sandboxCapability.missingRequirements,
    },
    "Sandbox capability evaluated",
  );
  const restrictedExecutionProfile = await validateRestrictedExecutionProfile(
    buildRestrictedExecutionProfile(config, sandboxCapability, adapter.type, sandboxRuntimeCache),
    realSpawner,
  );
  logger.info(
    {
      enabled: restrictedExecutionProfile.enabled,
      ready: restrictedExecutionProfile.ready,
      runtimeDigest: restrictedExecutionProfile.runtimeDigest,
      missingRequirements: restrictedExecutionProfile.missingRequirements,
    },
    "Restricted execution profile evaluated",
  );
  const sandboxProcessorEnabled =
    sandboxCapability.executionMode === "SelfAccount"
      ? sandboxCapability.enabled
      : sandboxCapability.readiness === "ready";
  const sandboxProcessor = sandboxProcessorEnabled
    ? new SandboxDispatchProcessor(
        new SandboxManifestVerifier({
          publicKeys: config.AGENT_SANDBOX_PUBLIC_KEYS_JSON,
          runtimeCache: sandboxRuntimeCache,
          nonceConsumer: new SandboxReplayNonceStore(db),
          accountVerifier: new LocalSandboxAccountVerifier(spawner),
          adapterType: adapter.type as "slurm" | "pbs-pro" | "torque" | "kubernetes",
          localExecutionMode: sandboxCapability.executionMode,
          processIdentity: sandboxProcessIdentity,
          rootImpersonationEnabled: config.AGENT_SANDBOX_ROOT_IMPERSONATION,
          sharedServiceAllowed: config.AGENT_SANDBOX_SHARED_SERVICE_ALLOWED,
          restrictedExecutionProfile: restrictedExecutionProfile.executionProfile,
        }),
        new SandboxStager({
          root: config.AGENT_SANDBOX_ROOT,
          processIdentity: sandboxProcessIdentity,
          kubernetesArtifactPvc: config.AGENT_SANDBOX_K8S_ARTIFACT_PVC,
          downloadInput: (input) =>
            downloadSandboxInput({
              ...input,
              connectTo: config.AGENT_FILE_TRANSFER_CONNECT_TO,
            }),
        }),
      )
    : undefined;
  let sandboxAttestationRefreshRunning = false;
  const sandboxAttestationRefresh = async () => {
    if (sandboxAttestationRefreshRunning) return;
    sandboxAttestationRefreshRunning = true;
    try {
      if (adapter.type === "kubernetes") {
        const previousReadiness = sandboxCapability.readiness;
        const previousMissingRequirements = sandboxCapability.missingRequirements.join(",");
        kubernetesSeccompProfile = await refreshKubernetesSandboxCapability(
          sandboxCapability,
          config,
          adapter.type,
          sandboxProcessIdentity,
          async () =>
            enforceKubernetesSeccompStartupBinding(
              await attestKubernetesSeccompProfile(config),
              kubernetesSeccompProfileBound,
            ),
        );
        if (
          sandboxCapability.readiness !== previousReadiness ||
          sandboxCapability.missingRequirements.join(",") !== previousMissingRequirements
        ) {
          logger.info(
            {
              readiness: sandboxCapability.readiness,
              missingRequirements: sandboxCapability.missingRequirements,
            },
            "Kubernetes Sandbox seccomp attestation changed",
          );
        }
        return;
      }
      if (!sandboxRuntimeAttestation) return;
      const next = await attestSandboxRuntimeEnvironment(
        config,
        adapter.type,
        spawner,
        sandboxProcessIdentity,
      );
      const runtimeCache = sandboxRuntimeAttestation.runtimeCache;
      const nextHasValidRuntime = Object.values(next.runtimeCache).some(
        (runtime) => runtime.expiresAtUnixMs > Date.now(),
      );
      if (!nextHasValidRuntime) {
        const previousHasValidRuntime = Object.values(runtimeCache).some(
          (runtime) => runtime.expiresAtUnixMs > Date.now(),
        );
        if (previousHasValidRuntime) {
          logger.warn(
            { missingRequirements: next.missingRequirements },
            "Sandbox runtime re-attestation failed; retaining unexpired evidence",
          );
          return;
        }
      }
      for (const digest of Object.keys(runtimeCache)) delete runtimeCache[digest];
      Object.assign(runtimeCache, next.runtimeCache);
      Object.assign(sandboxRuntimeAttestation, next, { runtimeCache });
      Object.assign(
        sandboxCapability,
        buildSandboxCapability(
          config,
          adapter.type,
          sandboxProcessIdentity,
          sandboxRuntimeAttestation,
        ),
      );
      logger.info(
        {
          readiness: sandboxCapability.readiness,
          runtimeCount: sandboxCapability.runtimeCache.length,
          missingRequirements: sandboxCapability.missingRequirements,
        },
        "Sandbox runtime attestation refreshed",
      );
    } finally {
      sandboxAttestationRefreshRunning = false;
    }
  };
  const sandboxAttestationRefreshIntervalMs =
    adapter.type === "kubernetes"
      ? Math.max(1_000, (config.HEARTBEAT_INTERVAL_SEC * 1_000) / 2)
      : Math.max(60_000, (config.AGENT_SANDBOX_ATTESTATION_TTL_SEC * 1_000) / 2);
  const sandboxAttestationRefreshTimer =
    config.AGENT_SANDBOX_ENABLED &&
    (sandboxCapability.executionMode === "SelfAccount" || adapter.type === "kubernetes")
      ? setInterval(() => {
          void sandboxAttestationRefresh().catch((err) => {
            logger.warn({ err }, "Sandbox runtime attestation refresh failed");
          });
        }, sandboxAttestationRefreshIntervalMs)
      : undefined;
  sandboxAttestationRefreshTimer?.unref();

  // Agent mTLS bootstrap. When AGENT_MTLS_REQUIRED=true we
  // either load the on-disk cert bundle or, on first start, mint a CSR
  // and POST it to the Server admin enrollment endpoint with
  // AGENT_ENROLL_TOKEN. The fingerprint is then stamped on every
  // outgoing connectRPC fetch so the Server guard maps it to the verified
  // agentId in the `agent_certs` ledger.
  let mtls: ClientFetchMtlsConfig = { enabled: false };
  if (config.AGENT_MTLS_REQUIRED) {
    if (!config.SERVER_HTTP_URL) {
      throw new Error("AGENT_MTLS_REQUIRED=true requires SERVER_HTTP_URL to be set");
    }
    if (!config.AGENT_ENROLL_TOKEN) {
      logger.warn(
        { certDir: config.AGENT_CERT_DIR },
        "AGENT_MTLS_REQUIRED=true with no AGENT_ENROLL_TOKEN — falling back to existing on-disk cert bundle. First-time enrollment will fail.",
      );
    }
    const enrollClient = createHttpEnrollmentClient({ serverBaseUrl: config.SERVER_HTTP_URL });
    const bundle = await ensureCertBundle({
      dir: config.AGENT_CERT_DIR,
      agentId: config.AGENT_ID,
      enrollmentToken: config.AGENT_ENROLL_TOKEN ?? "",
      client: enrollClient,
    });
    const fingerprintSha256 = fingerprintOfPem(bundle.certPem);
    logger.info({ fingerprint: fingerprintSha256 }, "Agent mTLS cert bundle ready");
    mtls = {
      enabled: true,
      fingerprintSha256,
      certPem: bundle.certPem,
      keyPem: bundle.keyPem,
      caCertPem: bundle.caCertPem,
    };
  }

  const serverTransportLiveness = {
    pingIntervalMs: config.AGENT_GRPC_PING_INTERVAL_SEC * 1000,
    pingTimeoutMs: config.AGENT_GRPC_PING_TIMEOUT_SEC * 1000,
  };
  const client = createServerClient(config.SERVER_GRPC_URL, mtls, serverTransportLiveness);
  const reachabilityProbe = config.AGENT_REACHABILITY_PROBE_ENABLED
    ? createServerReachabilityProbe(
        config.SERVER_GRPC_URL,
        mtls,
        serverTransportLiveness.pingTimeoutMs,
      )
    : undefined;
  logger.info(
    { serverUrl: config.SERVER_GRPC_URL, mtls: config.AGENT_MTLS_REQUIRED },
    "Server client created",
  );

  // bootstrap the SpackManager. Master switch + binary path
  // come from config; AGENT_SPACK_ENABLED=false (CI, k8s, edge) keeps the
  // manager `available=false` without probing a missing binary.
  const materialDelivery = configureSpackMaterialClient({
    enabled: config.AGENT_SPACK_ENABLED,
    serverUrl: config.SERVER_HTTP_URL,
    cacheDir: config.AGENT_SPACK_CACHE_DIR,
  });
  if (materialDelivery.unavailableReason) {
    logger.warn(
      { reason: materialDelivery.unavailableReason },
      "Spack material delivery unavailable",
    );
  }
  let materialAuditor: SpackSourceAuditor | undefined;
  let managedInstallation: ManagedSpackInstallation | undefined;
  if (config.AGENT_SPACK_AUDIT_ENABLED) {
    const apptainerSha256 = config.AGENT_SPACK_AUDIT_APPTAINER_SHA256;
    const sifPath = config.AGENT_SPACK_AUDIT_SIF_PATH;
    const sifSha256 = config.AGENT_SPACK_AUDIT_SIF_SHA256;
    if (!apptainerSha256 || !sifPath || !sifSha256) {
      throw new Error("Spack source audit runtime profile is incomplete");
    }
    const runtime = {
      apptainerPath: config.AGENT_SPACK_AUDIT_APPTAINER_PATH,
      apptainerSha256,
      sifPath,
      sifSha256,
    };
    materialAuditor = new SpackSourceAuditor({ profile: runtime });
    if (config.AGENT_SPACK_INSTALL_ENABLED) {
      const path = config.AGENT_SPACK_INSTALL_SITE_PROFILE_PATH;
      const sha256 = config.AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256;
      if (!path || !sha256 || adapter.type === "kubernetes") {
        throw new Error("Managed Spack installation requires a pinned native HPC site profile");
      }
      managedInstallation = new ManagedSpackInstallation({
        cacheDir: config.AGENT_SPACK_CACHE_DIR,
        site: { path, sha256, runtime },
        runner: new IsolatedSpackInstallRunner({ runtime }),
      });
    }
  }
  const spackManager = await SpackManager.bootstrap({
    enabled: config.AGENT_SPACK_ENABLED,
    binary: config.AGENT_SPACK_PATH,
    spawner,
    requireServerMaterials: true,
    materialClient: materialDelivery.client,
    materialAuditor,
    managedInstallation,
  });
  logger.info(
    {
      available: spackManager.available,
      version: spackManager.version,
      enabled: config.AGENT_SPACK_ENABLED,
      sourceAuditEnabled: config.AGENT_SPACK_AUDIT_ENABLED,
      managedInstallEnabled: config.AGENT_SPACK_INSTALL_ENABLED,
    },
    "Spack manager bootstrap complete",
  );

  // Unknown inventory must not be advertised as an authoritative empty snapshot.
  let installedSoftware: Awaited<ReturnType<typeof spackManager.installedList>> | undefined;
  if (spackManager.available) {
    try {
      installedSoftware = await spackManager.installedList();
      logger.info({ count: installedSoftware.length }, "Initial Spack installed-list cached");
    } catch (err) {
      logger.warn(
        { err },
        "Failed to read initial Spack installed-list; inventory remains unknown",
      );
    }
  }

  // attach the SSH relay handler unless explicitly disabled. The
  // factory receives the stream's outbound enqueue so SshOutput / SshClosed
  // frames ride the same connectRPC channel back to the Server gateway. When
  // AGENT_SSH_ENABLED=false, no handler is attached and the stream answers
  // every SshOpen with a synthetic "ssh handler disabled" close.
  const sshHandlerFactory = config.AGENT_SSH_ENABLED
    ? (enqueue: ConstructorParameters<typeof SshHandler>[0]["enqueue"]) =>
        new SshHandler({
          enqueue,
          logger: logger.child({ component: "ssh" }),
          strictAlgorithms: config.AGENT_SSH_STRICT_ALGORITHMS,
          keepaliveIntervalMs: config.AGENT_SSH_KEEPALIVE_SEC * 1000,
        })
    : undefined;
  logger.info({ enabled: config.AGENT_SSH_ENABLED }, "SSH relay configured");
  const licensedMaterialResolver = new LicensedMaterialResolver({
    restrictedRoot: config.AGENT_LICENSED_MATERIAL_ROOT,
    registry: config.AGENT_LICENSED_MATERIAL_REGISTRY_JSON,
    readonlyMountDriver,
  });
  const dataScanner =
    mtls.enabled && mtls.fingerprintSha256 && mtls.keyPem
      ? createCpLocalDataScanner({
          roots: dataRoots,
          agentId: config.AGENT_ID,
          signer: createCpLocalDataScanSigner({
            keyId: mtls.fingerprintSha256,
            privateKeyPem: mtls.keyPem,
          }),
        })
      : undefined;

  // Start bidirectional stream loop
  const stream = new AgentStream({
    client,
    clientFactory: () => createServerClient(config.SERVER_GRPC_URL, mtls, serverTransportLiveness),
    adapter,
    agentId: config.AGENT_ID,
    siteName: config.AGENT_SITE_NAME,
    heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_SEC * 1000,
    registrationTimeoutMs: config.AGENT_REGISTRATION_TIMEOUT_SEC * 1000,
    heartbeatAckTimeoutMs: config.AGENT_HEARTBEAT_ACK_TIMEOUT_SEC * 1000,
    ...(reachabilityProbe ? { reachabilityProbe } : {}),
    reachabilityProbeIntervalMs: serverTransportLiveness.pingIntervalMs,
    schedulerMetricsRefreshMs: config.AGENT_SCHEDULER_METRICS_INTERVAL_SEC * 1000,
    schedulerCliTimeoutMs: config.AGENT_SCHEDULER_CLI_TIMEOUT_SEC * 1000,
    metricsSpawner: spawner,
    logger,
    outboundQueue,
    inboundAcks,
    activeRemoteJobs,
    cleanupIntents,
    revocationTombstones,
    spackManager,
    installedSoftware,
    collectOutputs,
    ensureWorkingDir,
    sshHandlerFactory,
    slurmContainerId: config.AGENT_SLURM_CONTAINER_ID,
    fileTransferMaxRetries: config.AGENT_FILE_TRANSFER_MAX_RETRIES,
    fileTransferRetryBackoffSec: config.AGENT_FILE_TRANSFER_RETRY_BACKOFF_SEC,
    fileTransferConnectTo: config.AGENT_FILE_TRANSFER_CONNECT_TO,
    containerFileTransferConnectTo:
      config.AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO ?? config.AGENT_FILE_TRANSFER_CONNECT_TO,
    sandboxCapability,
    assertSandboxRuntimeAttestation: async (sandbox: SandboxJobSpec, runtimeDigest: string) => {
      if (sandbox.executionMode === "RootImpersonation") {
        if (adapter.type === "kubernetes") {
          await assertKubernetesSeccompProfileCurrent(config, kubernetesSeccompProfile);
        }
        return;
      }
      if (sandbox.executionMode !== "SelfAccount") {
        throw new Error("Sandbox scheduler submission has an unsupported execution mode");
      }
      const runtime = sandboxRuntimeAttestation?.runtimeCache[runtimeDigest];
      if (
        !runtime ||
        runtime.expiresAtUnixMs <= Date.now() ||
        runtime.kind !== sandbox.runtimeKind ||
        runtime.localPath !== sandbox.runtimePath ||
        runtime.runtimeAttestationId !== sandbox.runtimeAttestationId ||
        runtime.apptainerPath !== sandbox.apptainerPath ||
        runtime.seccompProfilePath !== sandbox.seccompProfilePath ||
        runtime.attestedNodes.length !== sandbox.attestedNodes?.length ||
        runtime.attestedNodes.some((node, index) => node !== sandbox.attestedNodes?.[index])
      ) {
        throw new Error(
          "SelfAccount Sandbox runtime attestation changed before scheduler submission",
        );
      }
    },
    restrictedExecutionProfile,
    removeRestrictedWorkRoot: (jobId) => removeSandboxRun(config.AGENT_SANDBOX_ROOT, jobId),
    sandboxProcessor,
    releaseSandboxArtifacts: (items) => releaseSandboxArtifacts(config.AGENT_SANDBOX_ROOT, items),
    licensedMaterialResolver,
    prepareJobWorkRoot: (jobId) => dataRoots.prepareJobRoot(jobId),
    removeJobWorkRoot: (jobId) => dataRoots.removeJobRoot(jobId),
    dataDeliveryExecutor,
    dataScanner,
  });

  process.on("SIGINT", () => {
    logger.info("SIGINT received — shutting down");
    if (sandboxAttestationRefreshTimer) clearInterval(sandboxAttestationRefreshTimer);
    stream.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received — shutting down");
    if (sandboxAttestationRefreshTimer) clearInterval(sandboxAttestationRefreshTimer);
    stream.stop();
  });

  await stream.start();
  if (sandboxAttestationRefreshTimer) clearInterval(sandboxAttestationRefreshTimer);
  logger.info("Agent stopped cleanly");
}

main().catch((err) => {
  console.error("Agent failed to start:", err);
  process.exit(1);
});
