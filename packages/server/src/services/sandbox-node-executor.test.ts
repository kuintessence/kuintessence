import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { PgDb } from "@kuintessence/db";
import { type RoleName, type SandboxSignedManifest, workflowDsl } from "@kuintessence/shared";
import type { JobService } from "./job-service";
import type { PlacementOrchestrator } from "./placement-orchestrator";
import type { SandboxExecutionResolver } from "./sandbox-execution-resolver";
import { SandboxManifestSigner } from "./sandbox-manifest-signer";
import { SandboxNodeExecutor } from "./sandbox-node-executor";
import { hashSandboxScript } from "./sandbox-script";
import type { WorkflowArtifactService } from "./workflow-artifact";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "66666666-6666-4666-8666-666666666666";
const ASSET_REVISION_ID = "77777777-7777-4777-8777-777777777777";

function fakeDb(
  agent: Record<string, unknown> = {
    siteId: "site-a",
    clusterId: "cluster-a",
    rootMode: true,
    sandboxCapabilities: { executionMode: "RootImpersonation" },
    sandboxRuntimeCache: [],
  },
): PgDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [agent],
  };
  return { select: () => chain } as unknown as PgDb;
}

describe("SandboxNodeExecutor", () => {
  test("dispatches only a signed manifest and registers verified output facts", async () => {
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "transform",
      name: "transform",
      source: {
        type: "AssetRevision",
        assetId: ASSET_ID,
        assetRevisionId: ASSET_REVISION_ID,
        revision: 1,
        sha256: hashSandboxScript("print('safe')"),
      },
      runtimeProfileId: PROFILE_ID,
      executionIdentity: { type: "MappedAuto" },
      outputs: {
        result: {
          type: "JSON",
          durability: "Ephemeral",
          sizeHint: { type: "FixedBytes", bytes: 128 },
        },
      },
    });
    if (node.type !== "Script") throw new Error("test fixture is not a Script node");
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new SandboxManifestSigner({
      keyId: "test-key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const resolver = {
      resolveSource: async () => ({
        language: "python" as const,
        entrypoint: "main.py",
        content: "print('safe')",
        sha256: hashSandboxScript("print('safe')"),
        assetRevisionId: ASSET_REVISION_ID,
        assetLifecycle: "published",
        runtimeContractRef: null,
      }),
      resolveRuntime: async () => ({
        id: PROFILE_ID,
        language: "python" as const,
        ociDigest: null,
        sifDigest: `sha256:${"a".repeat(64)}`,
        adapters: ["slurm"],
      }),
      runtimeForScheduler: () => ({ kind: "SIF" as const, digest: `sha256:${"a".repeat(64)}` }),
      resolveIdentity: async () => ({
        mode: "MappedAccount" as const,
        accountId: ACCOUNT_ID,
        backend: "Unix" as const,
        username: "scientist",
        uid: 1001,
        gid: 1001,
        schedulerAccount: "science",
        allowedQueues: ["normal"],
      }),
    } as unknown as SandboxExecutionResolver;
    const lifecycle: string[] = [];
    let dispatchedCommand = "";
    let signedScript = "";
    let signedManifest: SandboxSignedManifest | undefined;
    let submitOptions: Parameters<JobService["submit"]>[2];
    const orchestrator = {
      placeAndDispatch: async (input: {
        job: { command: string };
        sandboxExecution: {
          build: (selected: {
            agentId: string;
            schedulerType: string;
            providerOrgId: string | null;
          }) => Promise<{ script: { contentBase64: string } }>;
        };
      }) => {
        lifecycle.push("dispatch");
        dispatchedCommand = input.job.command;
        const manifest = await input.sandboxExecution.build({
          agentId: "agent-a",
          schedulerType: "slurm",
          providerOrgId: null,
        });
        signedManifest = manifest as SandboxSignedManifest;
        signedScript = Buffer.from(manifest.script.contentBase64, "base64").toString("utf8");
        return { dispatched: true, selectedAgentId: "agent-a", rejections: [] };
      },
    } as unknown as PlacementOrchestrator;
    const registered: Array<Record<string, unknown>> = [];
    const artifactService = {
      registerLocal: async (input: Record<string, unknown>) => {
        registered.push(input);
        return { id: "artifact-1" };
      },
    } as unknown as WorkflowArtifactService;
    const jobService = {
      submit: async (
        input: { command: string },
        _submittedBy: string,
        options: Parameters<JobService["submit"]>[2],
      ) => {
        lifecycle.push("submit");
        submitOptions = options;
        return {
          id: JOB_ID,
          name: "transform",
          command: input.command,
          cpus: 1,
          memoryMb: 1024,
          gpus: 0,
          wallTimeSec: 60,
          workingDir: null,
          queueId: null,
          orgId: null,
          expectedOutputs: [{ descriptor: "result", path: "outputs/result", isBatch: false }],
        };
      },
    } as unknown as JobService;
    const executor = new SandboxNodeExecutor({
      db: fakeDb(),
      resolver,
      signer,
      jobService,
      orchestrator,
      artifactService,
      awaitCompletion: async () => ({
        status: "completed",
        collected: {
          result: '{"ok":true}',
          "$sandbox-artifact:result": JSON.stringify({
            descriptor: "result",
            sha256: "b".repeat(64),
            sizeBytes: 11,
            storageRef: "/managed/run/outputs/result",
          }),
        },
      }),
      submittedBy: "55555555-5555-4555-8555-555555555555",
      userRole: "user" as RoleName,
      authorizeJobSubmission: async (input) => {
        lifecycle.push("authorize");
        expect(input).toEqual({ jobId: JOB_ID, orgId: null, queueId: null });
      },
      workflowRunId: RUN_ID,
      defaultExecutionIdentity: { type: "MappedAuto" },
      resolvePolicy: async () => ({
        sandboxEnabled: true,
        impersonationEnabled: true,
        selfAccountEnabled: false,
        degradedImpersonationAllowed: false,
        sharedServiceAllowed: false,
        runtimePrecacheRequired: true,
        limits: {
          maxCpuCores: 64,
          maxMemoryMb: 262_144,
          maxWallTimeSec: 86_400,
          maxPids: 64,
          maxOutputBytes: 1_024,
          maxLogBytes: 1_024,
        },
        disabledRuntimeProfileIds: [],
      }),
      limits: { pids: 64, outputBytes: 1_024, logBytes: 1_024 },
    });

    const result = await executor.execute(node, { nodes: {}, params: {} });

    expect(dispatchedCommand).toBe("sandbox-manifest");
    expect(lifecycle).toEqual(["submit", "authorize", "dispatch"]);
    expect(submitOptions).toMatchObject({
      trustedMaterialization: true,
      trustedSandboxScript: {
        revisionId: ASSET_REVISION_ID,
        sha256: hashSandboxScript("print('safe')"),
      },
    });
    expect(signedScript).toBe("print('safe')");
    expect(signedManifest?.executionMode).toBe("RootImpersonation");
    expect(result).toEqual({ status: "Succeeded", values: { result: { ok: true } } });
    expect(registered[0]).toMatchObject({
      workflowRunId: RUN_ID,
      producerNodeId: "transform",
      contentHash: "b".repeat(64),
      storageRef: "/managed/run/outputs/result",
    });
  });

  test("preserves failed Sandbox Job diagnostics in the node failure", async () => {
    const content = "print('fails')";
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "failed_transform",
      name: "failed transform",
      source: { type: "Inline", language: "python", content },
      runtimeProfileId: PROFILE_ID,
      executionIdentity: { type: "MappedAuto" },
      outputs: {},
    });
    if (node.type !== "Script") throw new Error("test fixture is not a Script node");
    const { privateKey } = generateKeyPairSync("ed25519");
    const executor = new SandboxNodeExecutor({
      db: fakeDb(),
      resolver: {
        resolveSource: async () => ({
          language: "python" as const,
          entrypoint: "main.py",
          content,
          sha256: hashSandboxScript(content),
          assetRevisionId: null,
          assetLifecycle: null,
          runtimeContractRef: null,
        }),
        resolveRuntime: async () => ({
          id: PROFILE_ID,
          language: "python" as const,
          ociDigest: null,
          sifDigest: `sha256:${"a".repeat(64)}`,
          adapters: ["slurm"],
        }),
      } as unknown as SandboxExecutionResolver,
      signer: new SandboxManifestSigner({
        keyId: "test-key",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
      jobService: {
        submit: async (input: Parameters<JobService["submit"]>[0]) => ({
          id: JOB_ID,
          name: input.name,
          command: input.command,
          cpus: 1,
          memoryMb: 1024,
          gpus: 0,
          wallTimeSec: 60,
          workingDir: null,
          queueId: null,
          orgId: null,
          expectedOutputs: [],
        }),
      } as unknown as JobService,
      orchestrator: {
        placeAndDispatch: async () => ({
          dispatched: true,
          selectedAgentId: "agent-a",
          rejections: [],
        }),
      } as unknown as PlacementOrchestrator,
      artifactService: {} as WorkflowArtifactService,
      awaitCompletion: async (jobId) => {
        expect(jobId).toBe(JOB_ID);
        return {
          status: "failed",
          collected: {},
          errorMessage: "LAMMPS input command failed at timestep 42",
          exitCode: 2,
        };
      },
      submittedBy: "55555555-5555-4555-8555-555555555555",
      userRole: "user" as RoleName,
      authorizeJobSubmission: async () => {},
      workflowRunId: RUN_ID,
      defaultExecutionIdentity: { type: "MappedAuto" },
      resolvePolicy: async () => {
        throw new Error("manifest construction must not run in this dispatch seam");
      },
      limits: { pids: 64, outputBytes: 1_024, logBytes: 1_024 },
    });

    await expect(executor.execute(node, { nodes: {}, params: {} })).resolves.toEqual({
      status: "Failed",
      values: {},
      failure: {
        message: "LAMMPS input command failed at timestep 42",
        jobId: JOB_ID,
        exitCode: 2,
      },
    });
  });

  test("fails closed before placement when Job authorization projection fails", async () => {
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "blocked_transform",
      name: "blocked transform",
      source: { type: "Inline", language: "python", content: "print('blocked')" },
      runtimeProfileId: PROFILE_ID,
      executionIdentity: { type: "MappedAuto" },
      outputs: {},
    });
    if (node.type !== "Script") throw new Error("test fixture is not a Script node");
    const { privateKey } = generateKeyPairSync("ed25519");
    const lifecycle: string[] = [];
    let submitOptions: Parameters<JobService["submit"]>[2];
    const executor = new SandboxNodeExecutor({
      db: fakeDb(),
      resolver: {
        resolveSource: async () => ({
          language: "python" as const,
          entrypoint: "main.py",
          content: "print('blocked')",
          sha256: hashSandboxScript("print('blocked')"),
          assetRevisionId: null,
          assetLifecycle: null,
          runtimeContractRef: null,
        }),
        resolveRuntime: async () => ({
          id: PROFILE_ID,
          language: "python" as const,
          ociDigest: null,
          sifDigest: `sha256:${"a".repeat(64)}`,
          adapters: ["slurm"],
        }),
      } as unknown as SandboxExecutionResolver,
      signer: new SandboxManifestSigner({
        keyId: "test-key",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
      jobService: {
        submit: async (
          _input: unknown,
          _submittedBy: string,
          options: Parameters<JobService["submit"]>[2],
        ) => {
          lifecycle.push("submit");
          submitOptions = options;
          return {
            id: JOB_ID,
            name: "blocked transform",
            command: "sandbox-manifest",
            cpus: 1,
            memoryMb: 1024,
            gpus: 0,
            wallTimeSec: 60,
            workingDir: null,
            queueId: null,
            orgId: null,
            expectedOutputs: [],
          };
        },
      } as unknown as JobService,
      authorizeJobSubmission: async () => {
        lifecycle.push("authorize");
        throw new Error("authorization projection failed");
      },
      orchestrator: {
        placeAndDispatch: async () => {
          lifecycle.push("dispatch");
          return { dispatched: false, selectedAgentId: null, rejections: [] };
        },
      } as unknown as PlacementOrchestrator,
      artifactService: {} as WorkflowArtifactService,
      awaitCompletion: async () => ({ status: "failed", collected: {} }),
      submittedBy: "55555555-5555-4555-8555-555555555555",
      userRole: "user" as RoleName,
      workflowRunId: RUN_ID,
      defaultExecutionIdentity: { type: "MappedAuto" },
      resolvePolicy: async () => ({
        sandboxEnabled: true,
        impersonationEnabled: true,
        selfAccountEnabled: false,
        degradedImpersonationAllowed: false,
        sharedServiceAllowed: false,
        runtimePrecacheRequired: true,
        limits: {
          maxCpuCores: 64,
          maxMemoryMb: 262_144,
          maxWallTimeSec: 86_400,
          maxPids: 64,
          maxOutputBytes: 1_024,
          maxLogBytes: 1_024,
        },
        disabledRuntimeProfileIds: [],
      }),
      limits: { pids: 64, outputBytes: 1_024, logBytes: 1_024 },
    });

    await expect(executor.execute(node, { nodes: {}, params: {} })).rejects.toThrow(
      "authorization projection failed",
    );
    expect(lifecycle).toEqual(["submit", "authorize"]);
    expect(submitOptions).toEqual({
      trustedMaterialization: false,
      workflow: { runId: RUN_ID, nodeId: "blocked_transform" },
    });
  });

  test("freezes Data Market FileBatch inputs on the Sandbox Job before placement", async () => {
    const node = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "restricted_transform",
      name: "restricted transform",
      source: {
        type: "AssetRevision",
        assetId: ASSET_ID,
        assetRevisionId: ASSET_REVISION_ID,
        revision: 1,
        sha256: hashSandboxScript("print('restricted')"),
      },
      runtimeProfileId: PROFILE_ID,
      executionIdentity: { type: "MappedAuto" },
      inputs: { dataset: { type: "FileBatch" } },
      inputSlots: [
        {
          type: "File",
          descriptor: "dataset",
          isBatch: true,
          from: { param: "dataset" },
        },
      ],
      outputs: {},
    });
    if (node.type !== "Script") throw new Error("test fixture is not a Script node");
    const { privateKey } = generateKeyPairSync("ed25519");
    let submittedJob: Parameters<JobService["submit"]>[0] | undefined;
    let placementRestrictedNoEgress: boolean | undefined;
    const executor = new SandboxNodeExecutor({
      db: fakeDb(),
      resolver: {
        resolveSource: async () => ({
          language: "python" as const,
          entrypoint: "main.py",
          content: "print('restricted')",
          sha256: hashSandboxScript("print('restricted')"),
          assetRevisionId: ASSET_REVISION_ID,
          assetLifecycle: "published",
          runtimeContractRef: null,
        }),
        resolveRuntime: async () => ({
          id: PROFILE_ID,
          language: "python" as const,
          ociDigest: null,
          sifDigest: `sha256:${"a".repeat(64)}`,
          adapters: ["slurm"],
        }),
      } as unknown as SandboxExecutionResolver,
      signer: new SandboxManifestSigner({
        keyId: "test-key",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
      jobService: {
        submit: async (input: Parameters<JobService["submit"]>[0]) => {
          submittedJob = input;
          return {
            id: JOB_ID,
            name: input.name,
            command: input.command,
            cpus: 1,
            memoryMb: 1024,
            gpus: 0,
            wallTimeSec: 60,
            workingDir: null,
            queueId: null,
            orgId: null,
            expectedOutputs: [],
            restrictedNoEgress: true,
          };
        },
      } as unknown as JobService,
      authorizeJobSubmission: async () => {},
      orchestrator: {
        placeAndDispatch: async (input: { restrictedNoEgress?: boolean }) => {
          placementRestrictedNoEgress = input.restrictedNoEgress;
          return { dispatched: false, selectedAgentId: null, rejections: [] };
        },
      } as unknown as PlacementOrchestrator,
      artifactService: {} as WorkflowArtifactService,
      awaitCompletion: async () => ({ status: "failed", collected: {} }),
      submittedBy: "55555555-5555-4555-8555-555555555555",
      userRole: "user" as RoleName,
      workflowRunId: RUN_ID,
      defaultExecutionIdentity: { type: "MappedAuto" },
      resolvePolicy: async () => {
        throw new Error("placement must fail before manifest construction");
      },
      limits: { pids: 64, outputBytes: 1_024, logBytes: 1_024 },
    });
    const dataInput = {
      source: "data-market" as const,
      assetId: "88888888-8888-4888-8888-888888888888",
      versionId: "99999999-9999-4999-8999-999999999999",
      manifestDigest: `sha256:${"b".repeat(64)}`,
      selectedEntries: ["restricted/input.dat"],
    };

    await expect(
      executor.execute(node, { nodes: {}, params: { dataset: dataInput } }),
    ).resolves.toEqual({
      status: "Failed",
      values: {},
      failure: {
        message:
          "Sandbox job was not dispatched because no eligible compute resource was available.",
        jobId: JOB_ID,
      },
    });
    expect(submittedJob?.dataInputs).toEqual({ dataset: dataInput });
    expect(submittedJob?.inputStaging).toEqual([]);
    expect(placementRestrictedNoEgress).toBe(true);
  });

  test("uses SelfAccount only for an exact self identity with a fresh runtime attestation", async () => {
    const runtimeDigest = `sha256:${"a".repeat(64)}`;
    const executor = new SandboxNodeExecutor({
      db: fakeDb({
        rootMode: false,
        sandboxCapabilities: {
          executionMode: "SelfAccount",
          selfAccount: { username: "kqagent", uid: 1001, gid: 1001 },
        },
        sandboxRuntimeCache: [
          {
            kind: "SIF",
            digest: runtimeDigest,
            signatureVerified: true,
            runtimeAttestationId: "8".repeat(64),
            attestedNodes: ["slurm-2"],
            expiresAtUnixMs: Date.now() + 60_000,
          },
        ],
      }),
    } as unknown as ConstructorParameters<typeof SandboxNodeExecutor>[0]);
    const resolveExecutionMode = executor as unknown as {
      executionModeForSelectedAgent(input: {
        agentId: string;
        schedulerType: string;
        identity: {
          mode: "MappedAccount";
          accountId: string;
          backend: "Unix";
          username: string;
          uid: number;
          gid: number;
          schedulerAccount: null;
          allowedQueues: string[];
        };
        runtime: { kind: "SIF"; digest: string };
        policy: {
          sandboxEnabled: boolean;
          impersonationEnabled: boolean;
          selfAccountEnabled: boolean;
          degradedImpersonationAllowed: boolean;
          sharedServiceAllowed: boolean;
          runtimePrecacheRequired: boolean;
          limits: {
            maxCpuCores: number;
            maxMemoryMb: number;
            maxWallTimeSec: number;
            maxPids: number;
            maxOutputBytes: number;
            maxLogBytes: number;
          };
          disabledRuntimeProfileIds: string[];
        };
        restrictedNoEgress: boolean;
      }): Promise<{ executionMode: string; runtimeAttestationId?: string }>;
    };
    const input = {
      agentId: "agent-a",
      schedulerType: "slurm",
      identity: {
        mode: "MappedAccount" as const,
        accountId: ACCOUNT_ID,
        backend: "Unix" as const,
        username: "kqagent",
        uid: 1001,
        gid: 1001,
        schedulerAccount: null,
        allowedQueues: ["normal"],
      },
      runtime: { kind: "SIF" as const, digest: runtimeDigest },
      policy: {
        sandboxEnabled: true,
        impersonationEnabled: false,
        selfAccountEnabled: true,
        degradedImpersonationAllowed: false,
        sharedServiceAllowed: false,
        runtimePrecacheRequired: true,
        limits: {
          maxCpuCores: 64,
          maxMemoryMb: 262_144,
          maxWallTimeSec: 86_400,
          maxPids: 64,
          maxOutputBytes: 1_024,
          maxLogBytes: 1_024,
        },
        disabledRuntimeProfileIds: [],
      },
      restrictedNoEgress: false,
    };

    await expect(resolveExecutionMode.executionModeForSelectedAgent(input)).resolves.toEqual({
      executionMode: "SelfAccount",
      runtimeAttestationId: "8".repeat(64),
    });
    await expect(
      resolveExecutionMode.executionModeForSelectedAgent({
        ...input,
        identity: { ...input.identity, uid: 1002 },
      }),
    ).rejects.toThrow("does not exactly match");
    await expect(
      resolveExecutionMode.executionModeForSelectedAgent({ ...input, restrictedNoEgress: true }),
    ).rejects.toThrow("cannot use SelfAccount");
    await expect(
      resolveExecutionMode.executionModeForSelectedAgent({ ...input, schedulerType: "pbs-pro" }),
    ).rejects.toThrow("currently limited to Slurm");
  });

  test("preserves RootImpersonation selection for legacy PBS, Torque, and Kubernetes agents", async () => {
    const rootExecutor = new SandboxNodeExecutor({
      db: fakeDb({
        rootMode: true,
        sandboxCapabilities: { executionMode: "RootImpersonation" },
        sandboxRuntimeCache: [],
      }),
    } as unknown as ConstructorParameters<typeof SandboxNodeExecutor>[0]);
    const resolveRootExecutionMode = rootExecutor as unknown as {
      executionModeForSelectedAgent(input: {
        agentId: string;
        schedulerType: string;
        identity: {
          mode: "MappedAccount";
          accountId: string;
          backend: "Unix";
          username: string;
          uid: number;
          gid: number;
          schedulerAccount: null;
          allowedQueues: string[];
        };
        runtime: { kind: "SIF"; digest: string };
        policy: {
          sandboxEnabled: boolean;
          impersonationEnabled: boolean;
          selfAccountEnabled: boolean;
          degradedImpersonationAllowed: boolean;
          sharedServiceAllowed: boolean;
          runtimePrecacheRequired: boolean;
          limits: {
            maxCpuCores: number;
            maxMemoryMb: number;
            maxWallTimeSec: number;
            maxPids: number;
            maxOutputBytes: number;
            maxLogBytes: number;
          };
          disabledRuntimeProfileIds: string[];
        };
        restrictedNoEgress: boolean;
      }): Promise<{ executionMode: string; runtimeAttestationId?: string }>;
    };
    const input = {
      agentId: "agent-a",
      schedulerType: "pbs-pro",
      identity: {
        mode: "MappedAccount" as const,
        accountId: ACCOUNT_ID,
        backend: "Unix" as const,
        username: "scientist",
        uid: 1001,
        gid: 1001,
        schedulerAccount: null,
        allowedQueues: ["normal"],
      },
      runtime: { kind: "SIF" as const, digest: `sha256:${"a".repeat(64)}` },
      policy: {
        sandboxEnabled: true,
        impersonationEnabled: true,
        selfAccountEnabled: true,
        degradedImpersonationAllowed: false,
        sharedServiceAllowed: false,
        runtimePrecacheRequired: true,
        limits: {
          maxCpuCores: 64,
          maxMemoryMb: 262_144,
          maxWallTimeSec: 86_400,
          maxPids: 64,
          maxOutputBytes: 1_024,
          maxLogBytes: 1_024,
        },
        disabledRuntimeProfileIds: [],
      },
      restrictedNoEgress: false,
    };

    for (const schedulerType of ["pbs-pro", "torque"]) {
      await expect(
        resolveRootExecutionMode.executionModeForSelectedAgent({ ...input, schedulerType }),
      ).resolves.toEqual({ executionMode: "RootImpersonation" });
    }

    const kubernetesExecutor = new SandboxNodeExecutor({
      db: fakeDb({
        rootMode: false,
        sandboxCapabilities: { executionMode: "RootImpersonation" },
        sandboxRuntimeCache: [],
      }),
    } as unknown as ConstructorParameters<typeof SandboxNodeExecutor>[0]);
    const resolveKubernetesExecutionMode =
      kubernetesExecutor as unknown as typeof resolveRootExecutionMode;
    await expect(
      resolveKubernetesExecutionMode.executionModeForSelectedAgent({
        ...input,
        schedulerType: "kubernetes",
      }),
    ).resolves.toEqual({ executionMode: "RootImpersonation" });
  });
});
