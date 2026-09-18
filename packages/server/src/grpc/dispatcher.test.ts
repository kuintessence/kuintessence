import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import {
  QueueTargetMode,
  QueueValidationMode,
  type ServerMessage,
  SoftwareOperationAction,
} from "@kuintessence/proto";
import type { SandboxSignedManifest } from "@kuintessence/shared";
import { AgentDispatcher, JobCancellationOutbox, JobWorkRootReleaseOutbox } from "./dispatcher";

function mockChannel() {
  const messages: ServerMessage[] = [];
  let closed = false;
  return {
    messages,
    isClosed: () => closed,
    push: (m: ServerMessage) => messages.push(m),
    close: () => {
      closed = true;
    },
  };
}

describe("AgentDispatcher", () => {
  test("does not send material credentials to a replaced legacy or unverified channel", () => {
    const dispatcher = new AgentDispatcher();
    const payload = {
      operationId: "material-operation",
      action: SoftwareOperationAction.INSTALL,
      spec: "zlib@1.3.1",
      requestedBy: "operator",
      spackMaterialTicket: "operation-scoped-ticket",
      spackManifestDigest: `sha256:${"d".repeat(64)}`,
    };
    const secure = {
      ...mockChannel(),
      spackMaterialDeliveryV1: true,
      verifiedCertFingerprint: "a".repeat(64),
    };
    dispatcher.register("a", secure);
    expect(dispatcher.pushSoftwareOperation("a", payload)).toBe(true);
    expect(secure.messages[0]?.payload.case).toBe("softwareOperationRequest");
    const legacy = mockChannel();
    dispatcher.register("a", legacy);
    expect(dispatcher.pushSoftwareOperation("a", payload)).toBe(false);
    expect(legacy.messages).toHaveLength(0);
    dispatcher.register("a", { ...legacy, spackMaterialDeliveryV1: true });
    expect(dispatcher.pushSoftwareOperation("a", payload)).toBe(false);
  });
  const sandboxExecution: SandboxSignedManifest = {
    jobId: "00000000-0000-0000-0000-000000000111",
    script: {
      language: "python",
      entrypoint: "main.py",
      contentBase64: Buffer.from("print('ok')\n").toString("base64"),
      sha256: "1".repeat(64),
      bundleSha256: "2".repeat(64),
    },
    runtime: {
      profileId: "00000000-0000-0000-0000-000000000222",
      kind: "SIF",
      digest: `sha256:${"3".repeat(64)}`,
    },
    executionMode: "RootImpersonation",
    executionProfile: {
      profileId: "00000000-0000-4000-8000-000000000444",
      apptainerCanonicalPath: "/opt/kq/bin/apptainer",
      apptainerSha256: "5".repeat(64),
      sifCanonicalPath: "/managed/runtime.sif",
      sifSha256: "3".repeat(64),
      trustedWrapperCanonicalPath: "/usr/libexec/kuintessence/kq-sandbox-wrapper",
      trustedWrapperSha256: "6".repeat(64),
    },
    identity: {
      mode: "MappedAccount",
      accountId: "00000000-0000-0000-0000-000000000333",
      backend: "Unix",
      username: "scientist",
      uid: 1001,
      gid: 1001,
      schedulerAccount: "science",
      allowedQueues: ["compute"],
    },
    mounts: [],
    limits: { pids: 32, outputBytes: 1_000, logBytes: 1_000 },
    networkDisabled: true,
    envelope: {
      keyId: "platform-key",
      nonce: "nonce-1234567890123456",
      issuedAtUnixMs: 1_720_915_200_000,
      expiresAtUnixMs: 1_720_915_260_000,
      manifestSha256: "4".repeat(64),
      signatureBase64: Buffer.from("signature").toString("base64"),
    },
  };

  test("isOnline reflects registration", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    expect(d.isOnline("a")).toBe(false);
    d.register("a", ch);
    expect(d.isOnline("a")).toBe(true);
    d.unregister("a");
    expect(d.isOnline("a")).toBe(false);
  });

  test("re-register closes previous channel", () => {
    const d = new AgentDispatcher();
    const old = mockChannel();
    d.register("a", old);
    d.register("a", mockChannel());
    expect(old.isClosed()).toBe(true);
  });

  test("stale unregister does not remove a replacement channel", () => {
    const d = new AgentDispatcher();
    const old = mockChannel();
    const replacement = mockChannel();
    d.register("a", old);
    d.register("a", replacement);
    d.unregister("a", old);
    expect(d.isOnline("a")).toBe(true);
    expect(d.getChannel("a")).toBe(replacement);
    d.unregister("a", replacement);
    expect(d.isOnline("a")).toBe(false);
  });

  test("pushDispatchJob enqueues DispatchJob payload", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    const ok = d.pushDispatchJob("a", "job-1", {
      jobIdInternal: "job-1",
      name: "n",
      command: "echo",
      resources: { cpus: 2, memoryMb: 4096 },
      dispatchEpoch: 7,
      queueName: "gpu",
      qos: "normal",
      stdinText: "hello\nworld\n",
    });
    expect(ok).toBe(true);
    expect(ch.messages).toHaveLength(1);
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("dispatchJob");
    if (m?.payload.case === "dispatchJob") {
      expect(m.payload.value.jobId).toBe("job-1");
      expect(m.payload.value.cpus).toBe(2);
      expect(m.payload.value.memoryMb).toBe(4096n);
      expect(m.payload.value.queueName).toBe("gpu");
      expect(m.payload.value.qos).toBe("normal");
      expect(m.payload.value.stdinText).toBe("hello\nworld\n");
      expect(m.payload.value.dispatchEpoch).toBe(7n);
    }
  });

  test("pushDispatchJob carries additive queue target and validation modes", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("queue-agent", ch);
    d.pushDispatchJob("queue-agent", "queue-job", {
      jobIdInternal: "queue-job",
      name: "queue",
      command: "true",
      resources: { cpus: 1, memoryMb: 512 },
      queueTargetMode: "default",
      queueValidationMode: "enforce",
    });
    const message = ch.messages[0];
    expect(message?.payload.case).toBe("dispatchJob");
    if (message?.payload.case === "dispatchJob") {
      expect(message.payload.value.queueName).toBe("");
      expect(message.payload.value.queueTargetMode).toBe(QueueTargetMode.DEFAULT);
      expect(message.payload.value.queueValidationMode).toBe(QueueValidationMode.ENFORCE);
    }
  });

  test("pushDispatchJob carries input staging + expected outputs (P4-f)", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    d.pushDispatchJob("a", "job-3", {
      jobIdInternal: "job-3",
      name: "n",
      command: "echo",
      resources: { cpus: 1, memoryMb: 512 },
      inputStaging: [
        { fileMetadataId: "fm-1", stagePath: "mesh.tar.gz", sourceUrl: "https://minio/get/fm-1" },
      ],
      expectedOutputs: [
        { descriptor: "result", path: "out/result", isBatch: false, pathsOnly: true },
      ],
      fileOutputDescriptors: ["result"],
    });
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("dispatchJob");
    if (m?.payload.case === "dispatchJob") {
      expect(m.payload.value.inputStaging[0]?.fileMetadataId).toBe("fm-1");
      expect(m.payload.value.inputStaging[0]?.stagePath).toBe("mesh.tar.gz");
      expect(m.payload.value.inputStaging[0]?.sourceUrl).toBe("https://minio/get/fm-1");
      expect(m.payload.value.expectedOutputs[0]?.descriptor).toBe("result");
      expect(m.payload.value.expectedOutputs[0]?.pathsOnly).toBe(true);
      expect(m.payload.value.fileOutputDescriptors).toEqual(["result"]);
    }
  });

  test("pushDispatchJob carries resolved Data Market entries without CP absolute paths", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    d.pushDispatchJob("a", "job-data", {
      jobIdInternal: "job-data",
      name: "data",
      command: "compute",
      resources: { cpus: 1, memoryMb: 512 },
      dataDeliveries: [
        {
          bindingId: "binding-1",
          inputDescriptor: "reference",
          locationId: "location-1",
          assetId: "asset-1",
          versionId: "version-1",
          manifestDigest: "f".repeat(64),
          selectedEntries: [
            {
              path: "reference/genome.fa",
              sha256: "a".repeat(64),
              sizeBytes: 42,
              objectDownloadUrl: "https://objects.test/short-lived",
            },
          ],
          stagePath: "inputs/reference",
          method: "object-download",
          restricted: false,
          leaseId: "11111111-1111-4111-8111-111111111111",
          leaseExpiresAtUnixMs: 1_900_000_000_000,
        },
        {
          bindingId: "binding-2",
          inputDescriptor: "potcar",
          locationId: "location-2",
          assetId: "asset-2",
          versionId: "version-2",
          manifestDigest: "e".repeat(64),
          selectedEntries: [{ path: "POTCAR", sha256: "b".repeat(64), sizeBytes: 8 }],
          stagePath: "inputs/potcar",
          method: "readonly-mount",
          managedRootId: "root-id",
          relativePath: "vasp/potcar-set",
          restricted: true,
          leaseId: "22222222-2222-4222-8222-222222222222",
          leaseExpiresAtUnixMs: 1_900_000_000_000,
        },
      ],
    });
    const message = ch.messages[0];
    if (message?.payload.case !== "dispatchJob") throw new Error("Dispatch message is missing");
    expect(message.payload.value.dataDeliveries).toHaveLength(2);
    const objectDelivery = message.payload.value.dataDeliveries[0];
    const localDelivery = message.payload.value.dataDeliveries[1];
    expect(objectDelivery?.selectedEntries[0]?.objectDownloadUrl).toBe(
      "https://objects.test/short-lived",
    );
    expect(localDelivery?.managedRootId).toBe("root-id");
    expect(localDelivery?.relativePath).toBe("vasp/potcar-set");
    expect(localDelivery?.selectedEntries[0]?.objectDownloadUrl).toBe("");
  });

  test("pushDispatchJob carries a structured signed Sandbox manifest", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    d.pushDispatchJob("a", sandboxExecution.jobId, {
      jobIdInternal: sandboxExecution.jobId,
      name: "sandbox",
      command: "must-not-be-authoritative",
      resources: { cpus: 1, memoryMb: 512 },
      sandboxExecution,
    });
    const message = ch.messages[0];
    expect(message?.payload.case).toBe("dispatchJob");
    if (message?.payload.case !== "dispatchJob") return;
    const sandbox = message.payload.value.sandboxExecution;
    expect(sandbox?.script?.entrypoint).toBe("main.py");
    expect(sandbox?.runtime?.digest).toBe(`sha256:${"3".repeat(64)}`);
    expect(sandbox?.executionMode).toBe("RootImpersonation");
    expect(sandbox?.runtimeAttestationId).toBe("");
    expect(sandbox?.executionProfile?.trustedWrapperSha256).toBe("6".repeat(64));
    expect(sandbox?.executionIdentity?.backend.case).toBe("unix");
    expect(sandbox?.envelope?.nonce).toBe("nonce-1234567890123456");
    expect(sandbox?.networkDisabled).toBe(true);
  });

  test("pushes a data delivery revocation without delivery URLs or paths", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    expect(d.pushDataDeliveryRevoke("a", "job-data", "DATA_GRANT_REVOKED", true, 7)).toBe(true);
    const message = ch.messages[0];
    expect(message?.payload).toEqual({
      case: "dataDeliveryRevoke",
      value: expect.objectContaining({
        jobId: "job-data",
        reasonCode: "DATA_GRANT_REVOKED",
        destroyRestrictedWorkRoot: true,
        revokedEpoch: 7n,
      }),
    });
  });

  test("pushDispatchJob returns false when agent not online", () => {
    const d = new AgentDispatcher();
    const ok = d.pushDispatchJob("nobody", "job-1", {
      jobIdInternal: "job-1",
      name: "n",
      command: "echo",
      resources: { cpus: 1, memoryMb: 1024 },
    });
    expect(ok).toBe(false);
  });

  test("failed channel push removes stale online state", () => {
    const d = new AgentDispatcher();
    d.register("a", {
      push: () => {
        throw new Error("agent stream closed");
      },
      close: () => {},
    });

    const ok = d.pushDispatchJob("a", "job-closed", {
      jobIdInternal: "job-closed",
      name: "n",
      command: "echo",
      resources: { cpus: 1, memoryMb: 1024 },
    });

    expect(ok).toBe(false);
    expect(d.isOnline("a")).toBe(false);
  });

  test("pushCancelJob enqueues CancelJob payload", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    const ok = d.pushCancelJob("a", "job-9", 8);
    expect(ok).toBe(true);
    expect(ch.messages).toHaveLength(1);
    expect(ch.messages[0]?.payload.case).toBe("cancelJob");
    if (ch.messages[0]?.payload.case === "cancelJob") {
      expect(ch.messages[0].payload.value.revokedEpoch).toBe(8n);
    }
  });

  test("pushCancelJob returns false when agent not online", () => {
    const d = new AgentDispatcher();
    expect(d.pushCancelJob("ghost", "job-99")).toBe(false);
  });

  test("pushReleaseJobWorkRoot targets the owning Agent", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);

    expect(d.pushReleaseJobWorkRoot("a", "job-output")).toBe(true);
    const message = ch.messages[0];
    expect(message?.payload.case).toBe("releaseJobWorkRoot");
    if (message?.payload.case === "releaseJobWorkRoot") {
      expect(message.payload.value.jobId).toBe("job-output");
    }
  });

  test("redelivers pending durable cancellations after Agent registration", async () => {
    const dispatcher = new AgentDispatcher();
    const channel = mockChannel();
    dispatcher.register("agent-reconnect", channel);
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [
              { jobId: "job-first", revokedEpoch: 3 },
              { jobId: "job-second", revokedEpoch: 4 },
            ],
          }),
        }),
      }),
    } as unknown as PgDb;
    const outbox = new JobCancellationOutbox(db, dispatcher);

    expect(await outbox.redeliver("agent-reconnect")).toBe(2);
    expect(channel.messages.map((message) => message.payload.case)).toEqual([
      "cancelJob",
      "cancelJob",
    ]);
    expect(
      channel.messages.flatMap((message) =>
        message.payload.case === "cancelJob" ? [message.payload.value.revokedEpoch] : [],
      ),
    ).toEqual([3n, 4n]);
  });

  test("redelivers pending durable Job work-root releases after Agent registration", async () => {
    const dispatcher = new AgentDispatcher();
    const channel = mockChannel();
    dispatcher.register("agent-reconnect", channel);
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [{ jobId: "job-first" }, { jobId: "job-second" }],
          }),
        }),
      }),
    } as unknown as PgDb;
    const outbox = new JobWorkRootReleaseOutbox(db, dispatcher);

    expect(await outbox.redeliver("agent-reconnect")).toBe(2);
    expect(channel.messages.map((message) => message.payload.case)).toEqual([
      "releaseJobWorkRoot",
      "releaseJobWorkRoot",
    ]);
  });

  test("pushSandboxArtifactRelease emits a structured managed-path request", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    expect(
      d.pushSandboxArtifactRelease("a", "release-1", [
        { replicaId: "replica-1", storageRef: "/managed/job/output" },
      ]),
    ).toBe(true);
    const message = ch.messages[0];
    expect(message?.payload.case).toBe("sandboxArtifactRelease");
    if (message?.payload.case === "sandboxArtifactRelease") {
      expect(message.payload.value.requestId).toBe("release-1");
      expect(message.payload.value.items[0]?.replicaId).toBe("replica-1");
    }
  });

  test("pushSoftwareOperation enqueues softwareOperationRequest payload", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    const ok = d.pushSoftwareOperation("a", {
      operationId: "00000000-0000-0000-0000-000000000001",
      action: SoftwareOperationAction.INSTALL,
      spec: "gromacs@2024.1",
      requestedBy: "00000000-0000-0000-0000-000000000002",
    });
    expect(ok).toBe(true);
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("softwareOperationRequest");
    if (m?.payload.case === "softwareOperationRequest") {
      expect(m.payload.value.action).toBe(SoftwareOperationAction.INSTALL);
      expect(m.payload.value.spec).toBe("gromacs@2024.1");
    }
  });

  test("pushDispatchJob sets envVars and wallTimeSec", () => {
    const d = new AgentDispatcher();
    const ch = mockChannel();
    d.register("a", ch);
    d.pushDispatchJob("a", "job-2", {
      jobIdInternal: "job-2",
      name: "test",
      command: "run",
      resources: { cpus: 4, memoryMb: 8192, gpus: 1, wallTimeSec: 3600 },
      envVars: { FOO: "bar" },
      workingDir: "/scratch",
    });
    const m = ch.messages[0];
    if (m?.payload.case === "dispatchJob") {
      expect(m.payload.value.gpus).toBe(1);
      expect(m.payload.value.wallTimeSec).toBe(3600n);
      expect(m.payload.value.envVars).toEqual({ FOO: "bar" });
      expect(m.payload.value.workingDir).toBe("/scratch");
    }
  });

  test("multiple agents can be registered independently", () => {
    const d = new AgentDispatcher();
    const ch1 = mockChannel();
    const ch2 = mockChannel();
    d.register("agent-1", ch1);
    d.register("agent-2", ch2);
    d.pushCancelJob("agent-1", "j1");
    d.pushCancelJob("agent-2", "j2");
    expect(ch1.messages).toHaveLength(1);
    expect(ch2.messages).toHaveLength(1);
  });
});
