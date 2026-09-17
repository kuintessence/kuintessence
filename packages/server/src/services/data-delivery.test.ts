import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { SandboxSignedManifest } from "@kuintessence/shared";
import type { ResolvedDataDelivery } from "./data-delivery";
import {
  assertDistinctDeliveryTargets,
  assertExactSelectedEntries,
  DataDeliveryResolver,
  RestrictedSandboxDeliveryBinder,
  selectLocation,
} from "./data-delivery";

const delivery = (bindingId: string, stagePath: string, paths: string[]): ResolvedDataDelivery => ({
  bindingId,
  inputDescriptor: "potcar",
  locationId: "location",
  assetId: "asset",
  versionId: "version",
  manifestDigest: "a".repeat(64),
  selectedEntries: paths.map((path) => ({ path, sha256: "a".repeat(64), sizeBytes: 1 })),
  stagePath,
  method: "object-download",
  restricted: false,
  leaseId: "11111111-1111-4111-8111-111111111111",
  leaseExpiresAtUnixMs: 1_900_000_000_000,
});

describe("Data Market delivery integrity", () => {
  test("rejects a delivery when returned entries do not exactly match the request", () => {
    expect(() => assertExactSelectedEntries(["a.csv", "b.csv"], [{ path: "a.csv" }])).toThrow(
      "DATA_DELIVERY_PATH_SET_MISMATCH",
    );
    expect(() =>
      assertExactSelectedEntries(["a.csv"], [{ path: "a.csv" }, { path: "extra.csv" }]),
    ).toThrow("DATA_DELIVERY_PATH_SET_MISMATCH");
  });

  test("rejects duplicate and ancestor delivery targets across bindings", () => {
    expect(() =>
      assertDistinctDeliveryTargets([
        delivery("one", "inputs", ["reference"]),
        delivery("two", "inputs/reference", ["mesh.dat"]),
      ]),
    ).toThrow("DATA_DELIVERY_TARGET_CONFLICT");
    expect(() =>
      assertDistinctDeliveryTargets([
        delivery("one", "inputs", ["mesh.dat"]),
        delivery("two", "inputs", ["mesh.dat"]),
      ]),
    ).toThrow("DATA_DELIVERY_TARGET_CONFLICT");
  });

  test("accepts non-overlapping final targets", () => {
    expect(() =>
      assertDistinctDeliveryTargets([
        delivery("one", "inputs/reference", ["mesh.dat"]),
        delivery("two", "inputs/potcar", ["POTCAR"]),
      ]),
    ).not.toThrow();
  });

  test("never falls back to object storage for restricted data", () => {
    const locations: Parameters<typeof selectLocation>[0] = [
      {
        id: "object",
        versionId: "version",
        kind: "platform-object",
        status: "available",
        agentId: null,
        managedRootId: null,
        relativePath: null,
        uri: "s3://bucket/object",
        replicaStatus: null,
        replicaManifestDigest: null,
        replicaVerifiedAt: null,
      },
    ];
    expect(selectLocation(locations, true)).toBeUndefined();
    expect(selectLocation(locations, true, true)?.id).toBe("object");
    expect(selectLocation(locations, false)?.id).toBe("object");
  });

  test("binds restricted object entries into signed readonly Sandbox mounts", () => {
    const executionProfile = {
      profileId: "00000000-0000-4000-8000-000000000004",
      apptainerCanonicalPath: "/opt/kq/bin/apptainer",
      apptainerSha256: "e".repeat(64),
      sifCanonicalPath: "/managed/runtime.sif",
      sifSha256: "c".repeat(64),
      trustedWrapperCanonicalPath: "/usr/libexec/kuintessence/kq-sandbox-wrapper",
      trustedWrapperSha256: "f".repeat(64),
    };
    const base: SandboxSignedManifest = { ...sandboxManifest(), executionProfile };
    const binder = new RestrictedSandboxDeliveryBinder({
      sign: (unsigned) => ({
        ...unsigned,
        envelope: {
          keyId: "test",
          nonce: "nonce-1234567890123456",
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 2,
          manifestSha256: "f".repeat(64),
          signatureBase64: "signature",
        },
      }),
    });
    const bound = binder.bind(base, [
      {
        ...delivery("binding", "inputs/potcar", ["POTCAR"]),
        restricted: true,
        selectedEntries: [
          {
            path: "POTCAR",
            sha256: "a".repeat(64),
            sizeBytes: 8,
            objectDownloadUrl: "https://objects.test/potcar",
          },
        ],
      },
    ]);
    expect(bound.manifest.mounts.at(-1)).toMatchObject({
      descriptor: "potcar",
      mode: "ReadOnly",
      ioType: "FileBatch",
      containerPath: "/kq/inputs/potcar",
      batchEntries: [{ relativePath: "POTCAR", sha256: "a".repeat(64), sizeBytes: 8 }],
    });
    expect(bound.manifest.executionMode).toBe("RootImpersonation");
    expect(bound.manifest.executionProfile).toEqual(executionProfile);
    expect(bound.inputStaging).toEqual([
      expect.objectContaining({
        stagePath: "inputs/potcar/POTCAR",
        deliveryLeaseId: "11111111-1111-4111-8111-111111111111",
      }),
    ]);
  });

  test("rejects a restricted Sandbox descriptor that cannot form a canonical mount", () => {
    const binder = new RestrictedSandboxDeliveryBinder({
      sign: (unsigned) => ({ ...unsigned, envelope: sandboxManifest().envelope }),
    });
    for (const inputDescriptor of ["../escape", ".", ".."]) {
      expect(() =>
        binder.bind(sandboxManifest(), [
          {
            ...delivery("binding", "inputs/escape", ["input.dat"]),
            inputDescriptor,
            selectedEntries: [
              {
                path: "input.dat",
                sha256: "a".repeat(64),
                sizeBytes: 8,
                objectDownloadUrl: "https://objects.test/input.dat",
              },
            ],
          },
        ]),
      ).toThrow("input descriptor is invalid");
    }
  });

  test("preserves a SelfAccount runtime attestation while adding readonly mounts", () => {
    const runtimeAttestationId = "d".repeat(64);
    const base: SandboxSignedManifest = {
      ...sandboxManifest(),
      executionMode: "SelfAccount",
      runtimeAttestationId,
    };
    const binder = new RestrictedSandboxDeliveryBinder({
      sign: (unsigned) => ({ ...unsigned, envelope: sandboxManifest().envelope }),
    });

    const bound = binder.bind(base, [
      {
        ...delivery("binding", "inputs/potcar", ["POTCAR"]),
        selectedEntries: [
          {
            path: "POTCAR",
            sha256: "a".repeat(64),
            sizeBytes: 8,
            objectDownloadUrl: "https://objects.test/potcar",
          },
        ],
      },
    ]);

    expect(bound.manifest.executionMode).toBe("SelfAccount");
    expect(bound.manifest.runtimeAttestationId).toBe(runtimeAttestationId);
  });

  test("resolves ordinary object delivery through the immutable bucket and exact version", async () => {
    const minio = recordingImmutableMinio();
    const resolver = new DataDeliveryResolver(
      fakeResolverDb([bindingRows(), locationRows(), entryRows()]),
      minio,
      { verifyAccess: async () => true },
    );

    const [resolved] = await resolver.resolveForDispatch({
      jobId: "job-1",
      actorUserId: "user-1",
      orgId: "org-1",
      agentId: "agent-1",
    });

    expect(resolved?.selectedEntries[0]?.objectDownloadUrl).toContain("immutable-bucket");
    expect(minio.calls).toEqual([
      {
        key: "data-market/immutable/sha256/object-digest",
        versionId: "immutable-version-1",
      },
    ]);
  });

  test("keeps a frozen delivery on its committed version after a later same-key version exists", async () => {
    const minio = recordingImmutableMinio({ latestVersionId: "attacker-version-2" });
    const resolver = new DataDeliveryResolver(
      fakeResolverDb([bindingRows(), locationRows(), entryRows()]),
      minio,
      { verifyAccess: async () => true },
    );

    await resolver.resolveForDispatch({
      jobId: "job-1",
      actorUserId: "user-1",
      orgId: "org-1",
      agentId: "agent-1",
    });

    expect(minio.latestVersionId).toBe("attacker-version-2");
    expect(minio.calls).toEqual([
      {
        key: "data-market/immutable/sha256/object-digest",
        versionId: "immutable-version-1",
      },
    ]);
  });

  test("binds restricted Sandbox delivery from the immutable bucket and exact version", async () => {
    const minio = recordingImmutableMinio();
    const resolver = new DataDeliveryResolver(
      fakeResolverDb([
        bindingRows({ sensitivity: "restricted", egressPolicy: "deny" }),
        locationRows(),
        [{ restrictedDataIsolation: true }],
        entryRows(),
      ]),
      minio,
      { verifyAccess: async () => true },
    );
    const deliveries = await resolver.resolveForDispatch({
      jobId: "job-1",
      actorUserId: "user-1",
      orgId: "org-1",
      agentId: "agent-1",
    });
    const binder = new RestrictedSandboxDeliveryBinder({
      sign: (unsigned) => ({ ...unsigned, envelope: sandboxManifest().envelope }),
    });

    const bound = binder.bind(sandboxManifest(), deliveries);

    expect(bound.inputStaging[0]?.sourceUrl).toContain("immutable-bucket");
    expect(minio.calls[0]?.versionId).toBe("immutable-version-1");
  });

  test("rejects a Data Market location that points at an attacker-controlled bucket", async () => {
    const minio = recordingImmutableMinio();
    const resolver = new DataDeliveryResolver(
      fakeResolverDb([
        bindingRows(),
        locationRows({ uri: "s3://attacker-bucket/data-market/immutable/sha256/object-digest" }),
        entryRows(),
      ]),
      minio,
      { verifyAccess: async () => true },
    );

    await expect(
      resolver.resolveForDispatch({
        jobId: "job-1",
        actorUserId: "user-1",
        orgId: "org-1",
        agentId: "agent-1",
      }),
    ).rejects.toThrow("DATA_OBJECT_LOCATION_INVALID");
    expect(minio.calls).toEqual([]);
  });

  test("rejects an immutable Data Market object without a fixed version", async () => {
    const minio = recordingImmutableMinio();
    const resolver = new DataDeliveryResolver(
      fakeResolverDb([bindingRows(), locationRows(), entryRows({ objectVersionId: null })]),
      minio,
      { verifyAccess: async () => true },
    );

    await expect(
      resolver.resolveForDispatch({
        jobId: "job-1",
        actorUserId: "user-1",
        orgId: "org-1",
        agentId: "agent-1",
      }),
    ).rejects.toThrow("DATA_OBJECT_VERSION_MISSING");
    expect(minio.calls).toEqual([]);
  });
});

function fakeResolverDb(results: readonly unknown[][]): PgDb {
  const pending = [...results];
  const query = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const result = Promise.resolve(pending.shift() ?? []);
        return Object.assign(result, { limit: () => result });
      },
    };
    return chain;
  };
  return { select: () => query() } as unknown as PgDb;
}

function bindingRows(
  overrides: { sensitivity?: string | null; egressPolicy?: "allow" | "deny" } = {},
): unknown[] {
  return [
    {
      id: "binding-1",
      inputDescriptor: "dataset",
      assetId: "asset-1",
      versionId: "version-1",
      manifestDigest: "a".repeat(64),
      selectedEntries: ["input.dat"],
      allowedLocationIds: ["location-1"],
      stagePath: "inputs/dataset",
      sensitivity: overrides.sensitivity ?? null,
      assetKind: null,
      egressPolicy: overrides.egressPolicy ?? "allow",
    },
  ];
}

function locationRows(overrides: { uri?: string } = {}): unknown[] {
  return [
    {
      id: "location-1",
      versionId: "version-1",
      kind: "platform-object",
      status: "available",
      agentId: null,
      managedRootId: null,
      relativePath: null,
      uri:
        overrides.uri ??
        "s3://data-market-immutable-bucket/data-market/immutable/sha256/object-digest",
      versionManifestDigest: "a".repeat(64),
      replicaStatus: null,
      replicaManifestDigest: null,
      replicaVerifiedAt: null,
    },
  ];
}

function entryRows(overrides: { objectVersionId?: string | null } = {}): unknown[] {
  const objectVersionId =
    overrides.objectVersionId === undefined ? "immutable-version-1" : overrides.objectVersionId;
  return [
    {
      path: "input.dat",
      sha256: "b".repeat(64),
      sizeBytes: 4,
      locationId: "location-1",
      fileMetadata: {
        objectKey: "data-market/immutable/sha256/object-digest",
        ...(objectVersionId ? { objectVersionId } : {}),
      },
    },
  ];
}

function recordingImmutableMinio(options: { latestVersionId?: string } = {}) {
  const calls: Array<{ key: string; versionId: string }> = [];
  return {
    dataMarketImmutableBucket: "data-market-immutable-bucket",
    calls,
    latestVersionId: options.latestVersionId,
    presignImmutableDownload: async (key: string, _expires: number, versionId: string) => {
      calls.push({ key, versionId });
      return `https://fake-minio.test/immutable-bucket/${encodeURIComponent(key)}?versionId=${versionId}`;
    },
    presignDownload: async () => {
      throw new Error("Data Market delivery must not use the ordinary NetDrive download signer");
    },
  };
}

function sandboxManifest(): SandboxSignedManifest {
  return {
    jobId: "00000000-0000-0000-0000-000000000001",
    script: {
      language: "bash",
      entrypoint: "main.sh",
      contentBase64: Buffer.from("true").toString("base64"),
      sha256: "a".repeat(64),
      bundleSha256: "b".repeat(64),
    },
    runtime: {
      profileId: "00000000-0000-0000-0000-000000000002",
      kind: "SIF",
      digest: `sha256:${"c".repeat(64)}`,
    },
    executionMode: "RootImpersonation",
    identity: {
      mode: "MappedAccount",
      accountId: "00000000-0000-0000-0000-000000000003",
      backend: "Unix",
      username: "user",
      uid: 1,
      gid: 1,
      schedulerAccount: null,
      allowedQueues: [],
    },
    mounts: [],
    limits: { pids: 1, outputBytes: 1, logBytes: 1 },
    networkDisabled: true,
    envelope: {
      keyId: "test",
      nonce: "nonce-1234567890123456",
      issuedAtUnixMs: 1,
      expiresAtUnixMs: 2,
      manifestSha256: "d".repeat(64),
      signatureBase64: "signature",
    },
  };
}
