import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { sameDispatchIntent } from "./dispatch-intent";
import {
  DispatchJobSchema,
  SandboxExecutionSchema,
} from "./generated/kuintessence/v1/agent_service_pb";

const original = create(DispatchJobSchema, {
  jobId: "job",
  dispatchEpoch: 1n,
  federationExecution: true,
  command: "fixed-command",
  dataDeliveries: [
    {
      bindingId: "binding",
      versionId: "fixed-version",
      leaseId: "old",
      leaseExpiresAtUnixMs: 1000n,
      selectedEntries: [
        {
          path: "input",
          sha256: "fixed-digest",
          sizeBytes: 1n,
          objectDownloadUrl: "https://objects.test/old",
        },
      ],
    },
  ],
  inputStaging: [
    {
      stagePath: "leased",
      sourceUrl: "https://objects.test/old",
      deliveryLeaseId: "old",
      deliveryLeaseExpiresAtUnixMs: 1000n,
    },
    { stagePath: "ordinary", sourceUrl: "https://objects.test/fixed" },
  ],
});

test("dispatch renewal changes only existing lease credentials", () => {
  const renewed = clone(DispatchJobSchema, original);
  const binding = renewed.dataDeliveries[0];
  const entry = binding?.selectedEntries[0];
  const staged = renewed.inputStaging[0];
  if (!binding || !entry || !staged) throw new Error("Missing fixture");
  binding.leaseId = "new";
  binding.leaseExpiresAtUnixMs = 2000n;
  entry.objectDownloadUrl = "https://objects.test/new";
  staged.deliveryLeaseId = "new";
  staged.deliveryLeaseExpiresAtUnixMs = 2000n;
  staged.sourceUrl = "https://objects.test/new";
  expect(sameDispatchIntent(original, renewed)).toBe(true);
  expect(original.dataDeliveries[0]?.leaseId).toBe("old");
  expect(renewed.dataDeliveries[0]?.leaseId).toBe("new");
});

test.each([
  "version",
  "digest",
  "path",
  "ordinary-url",
  "new-lease",
  "order",
  "removed-input",
])("credential renewal rejects changed %s", (field) => {
  const renewed = clone(DispatchJobSchema, original);
  const binding = renewed.dataDeliveries[0];
  const entry = binding?.selectedEntries[0];
  const ordinary = renewed.inputStaging[1];
  if (!binding || !entry || !ordinary) throw new Error("Missing fixture");
  switch (field) {
    case "version":
      binding.versionId = "other";
      break;
    case "digest":
      entry.sha256 = "other";
      break;
    case "path":
      entry.path = "other";
      break;
    case "ordinary-url":
      ordinary.sourceUrl = "https://objects.test/other";
      break;
    case "new-lease":
      ordinary.deliveryLeaseId = "new";
      break;
    case "order":
      renewed.inputStaging.reverse();
      break;
    case "removed-input":
      renewed.inputStaging.pop();
      break;
  }
  expect(sameDispatchIntent(original, renewed)).toBe(false);
});

test("Sandbox renewal changes only envelope credentials and requires the original signed content", () => {
  const dispatch = clone(DispatchJobSchema, original);
  dispatch.sandboxExecution = create(SandboxExecutionSchema, {
    runtime: { digest: "original-image" },
    computeResources: { cpus: 1, memoryMb: 128n },
    networkDisabled: true,
    envelope: {
      keyId: "old-key",
      nonce: "old-nonce",
      issuedAtUnixMs: 1n,
      expiresAtUnixMs: 2n,
      manifestSha256: "fixed-content",
      signature: new Uint8Array([1]),
    },
  });
  const renewed = clone(DispatchJobSchema, dispatch);
  const execution = renewed.sandboxExecution;
  if (!execution?.envelope || !execution.runtime) throw new Error("Missing fixture");
  Object.assign(execution.envelope, {
    keyId: "new-key",
    nonce: "new-nonce",
    issuedAtUnixMs: 3n,
    expiresAtUnixMs: 4n,
    signature: new Uint8Array([2]),
  });
  expect(sameDispatchIntent(dispatch, renewed)).toBe(true);
  if (!execution.computeResources) throw new Error("Missing resources");
  execution.computeResources.cpus = 2;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  execution.computeResources.cpus = 1;
  execution.computeResources.memoryMb = 256n;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  execution.computeResources.memoryMb = 128n;
  execution.runtime.digest = "changed-image";
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  execution.runtime.digest = "original-image";
  execution.envelope.manifestSha256 = "changed-content";
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  execution.envelope.manifestSha256 = "fixed-content";
  dispatch.federationExecution = renewed.federationExecution = false;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  dispatch.federationExecution = renewed.federationExecution = true;
  execution.envelope = undefined;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
});

test("NetDrive renewal preserves file identity, digest, size, marker and target path", () => {
  const dispatch = create(DispatchJobSchema, {
    federationExecution: true,
    inputStaging: [
      {
        fileMetadataId: crypto.randomUUID(),
        stagePath: "input.txt",
        netdriveInput: true,
        expectedSha256: "a".repeat(64),
        totalBytes: 4n,
        sourceUrl: "https://objects.test/old",
        deliveryLeaseId: "old",
        deliveryLeaseExpiresAtUnixMs: 1n,
      },
    ],
  });
  const renewed = clone(DispatchJobSchema, dispatch);
  const input = renewed.inputStaging[0];
  if (!input) throw new Error("Missing input");
  input.sourceUrl = "https://objects.test/new";
  input.deliveryLeaseId = "new";
  input.deliveryLeaseExpiresAtUnixMs = 100n;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(true);
  for (const change of [
    { fileMetadataId: crypto.randomUUID() },
    { expectedSha256: "b".repeat(64) },
    { totalBytes: 5n },
    { netdriveInput: false },
    { stagePath: "other.txt" },
  ]) {
    const changed = clone(DispatchJobSchema, renewed);
    Object.assign(changed.inputStaging[0] ?? {}, change);
    expect(sameDispatchIntent(dispatch, changed)).toBe(false);
  }
  const legacy = clone(DispatchJobSchema, dispatch);
  Object.assign(legacy.inputStaging[0] ?? {}, {
    netdriveInput: false,
    expectedSha256: "",
    totalBytes: 0n,
  });
  expect(sameDispatchIntent(legacy, renewed)).toBe(false);
});

test("local data source identity is immutable across execution renewal", () => {
  const dispatch = create(DispatchJobSchema, {
    inputStaging: [
      {
        stagePath: "inputs/data/input.dat",
        deliveryLeaseId: "old",
        deliveryLeaseExpiresAtUnixMs: 1n,
        localDataSource: {
          locationId: "location",
          managedRootId: "root",
          relativePath: "dataset/input.dat",
        },
      },
    ],
  });
  const renewed = clone(DispatchJobSchema, dispatch);
  const input = renewed.inputStaging[0];
  if (!input?.localDataSource) throw new Error("Missing local source");
  input.deliveryLeaseId = "new";
  input.deliveryLeaseExpiresAtUnixMs = 2n;
  expect(sameDispatchIntent(dispatch, renewed)).toBe(true);
  input.localDataSource.locationId = "other";
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
  input.localDataSource.locationId = "location";
  input.sourceUrl = "https://unexpected.test/data";
  expect(sameDispatchIntent(dispatch, renewed)).toBe(false);
});
