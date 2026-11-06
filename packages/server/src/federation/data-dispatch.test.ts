import { expect, test } from "bun:test";
import { create, equals, toBinary } from "@bufbuild/protobuf";
import {
  SandboxExecutionSchema,
  SandboxIoType,
  SandboxMountMode,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { AgentDispatcher } from "../grpc/dispatcher";
import type { ResolvedDataDelivery } from "../services/data-delivery";
import { refreshDataCredentials } from "./data-dispatch";

function fixture() {
  const delivery: ResolvedDataDelivery = {
    bindingId: crypto.randomUUID(),
    inputDescriptor: "data",
    locationId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    selectedEntries: [
      {
        path: "input.txt",
        sha256: "b".repeat(64),
        sizeBytes: 4,
        objectDownloadUrl: "https://objects.test/old",
      },
    ],
    stagePath: "inputs/data",
    method: "object-download",
    restricted: false,
    leaseId: crypto.randomUUID(),
    leaseExpiresAtUnixMs: 1,
  };
  const message = new AgentDispatcher().buildDispatchJob(crypto.randomUUID(), {
    jobIdInternal: crypto.randomUUID(),
    name: "Test",
    command: "original-command",
    resources: { cpus: 1, memoryMb: 128 },
    dispatchEpoch: 1,
    dataDeliveries: [delivery],
  });
  const next = {
    ...delivery,
    leaseId: crypto.randomUUID(),
    leaseExpiresAtUnixMs: Date.now() + 60_000,
    selectedEntries: delivery.selectedEntries.map((entry) => ({
      ...entry,
      objectDownloadUrl: "https://objects.test/new",
    })),
  };
  return { message, delivery, next };
}

test("renewal changes only transient credentials and does not mutate the stored envelope", () => {
  const { message, next } = fixture();
  const original = toBinary(ServerMessageSchema, message);
  const refreshed = refreshDataCredentials(message, [next]);
  expect(toBinary(ServerMessageSchema, message)).toEqual(original);
  if (refreshed.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  expect(refreshed.payload.value.command).toBe("original-command");
  expect(refreshed.payload.value.dataDeliveries[0]?.leaseId).toBe(next.leaseId);
  expect(refreshed.payload.value.dataDeliveries[0]?.selectedEntries[0]?.objectDownloadUrl).toBe(
    "https://objects.test/new",
  );
});

test("database row ordering cannot change the committed entry ordering", () => {
  const { message, next } = fixture();
  if (message.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  const original = message.payload.value.dataDeliveries[0];
  const entry = original?.selectedEntries[0];
  const renewedEntry = next.selectedEntries[0];
  if (!original || !entry || !renewedEntry) throw new Error("Expected data entries");
  original.selectedEntries.push({ ...entry, path: "other.txt" });
  next.selectedEntries.unshift({ ...renewedEntry, path: "other.txt" });
  const refreshed = refreshDataCredentials(message, [next]);
  if (refreshed.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  expect(
    refreshed.payload.value.dataDeliveries[0]?.selectedEntries.map((item) => item.path),
  ).toEqual(["input.txt", "other.txt"]);
});

test.each([
  "version",
  "location",
  "path",
  "digest",
  "size",
  "restricted",
  "missing",
  "extra",
] as const)("renewal rejects changed %s", (change) => {
  const { message, next } = fixture();
  let deliveries = [next];
  const entry = next.selectedEntries[0];
  if (!entry) throw new Error("Expected entry");
  switch (change) {
    case "version":
      next.versionId = crypto.randomUUID();
      break;
    case "location":
      next.locationId = crypto.randomUUID();
      break;
    case "path":
      next.stagePath = "other-path";
      break;
    case "digest":
      entry.sha256 = "c".repeat(64);
      break;
    case "size":
      entry.sizeBytes = 5;
      break;
    case "restricted":
      next.restricted = true;
      break;
    case "missing":
      deliveries = [];
      break;
    case "extra":
      deliveries.push({ ...next, bindingId: crypto.randomUUID() });
      break;
  }
  expect(() => refreshDataCredentials(message, deliveries)).toThrow("authorized binding");
});

function restrictedFixture() {
  const { message, delivery, next } = fixture();
  if (message.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  const dispatch = message.payload.value;
  dispatch.dataDeliveries = [];
  dispatch.restrictedNoEgress = true;
  dispatch.sandboxExecution = create(SandboxExecutionSchema, {
    networkDisabled: true,
    envelope: {
      keyId: "test-key",
      nonce: "original-nonce",
      signature: new Uint8Array([1, 2, 3]),
      expiresAtUnixMs: BigInt(Date.now() + 60_000),
    },
    artifactMounts: [
      {
        descriptor: "data",
        ioType: SandboxIoType.FILE_BATCH,
        mode: SandboxMountMode.READ_ONLY,
        relativePath: "inputs/data",
        containerPath: "/kq/inputs/data",
        batchEntries: [{ relativePath: "input.txt", sha256: "b".repeat(64), sizeBytes: 4n }],
      },
    ],
  });
  // Build the input with the normal proto factory, including its message metadata.
  const staged = new AgentDispatcher().buildDispatchJob(dispatch.jobId, {
    jobIdInternal: dispatch.jobId,
    name: "Staging",
    command: "true",
    resources: { cpus: 1, memoryMb: 128 },
    inputStaging: [
      {
        fileMetadataId: `data-delivery-${delivery.bindingId}-0`,
        stagePath: "inputs/data/input.txt",
        sourceUrl: "https://objects.test/old",
      },
    ],
  });
  if (staged.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  dispatch.inputStaging = staged.payload.value.inputStaging;
  const input = dispatch.inputStaging[0];
  if (!input) throw new Error("Expected input");
  input.deliveryLeaseId = delivery.leaseId;
  input.deliveryLeaseExpiresAtUnixMs = 1n;
  return { message, next, dispatch, input };
}

test("restricted input renewal preserves the signed sandbox contract", () => {
  const { message, next, dispatch } = restrictedFixture();
  const refreshed = refreshDataCredentials(message, [next]);
  if (refreshed.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
  const result = refreshed.payload.value;
  if (!result.sandboxExecution || !dispatch.sandboxExecution) throw new Error("Expected sandbox");
  expect(equals(SandboxExecutionSchema, result.sandboxExecution, dispatch.sandboxExecution)).toBe(
    true,
  );
  expect(result.inputStaging[0]?.sourceUrl).toBe("https://objects.test/new");
  expect(result.inputStaging[0]?.deliveryLeaseId).toBe(next.leaseId);
});

test("restricted data renewal rejects content changes and leaves signature renewal to dispatch authorization", () => {
  const f = restrictedFixture();
  const entry = f.next.selectedEntries[0];
  if (!entry) throw new Error("Expected entry");
  entry.sha256 = "c".repeat(64);
  expect(() => refreshDataCredentials(f.message, [f.next])).toThrow("authorized binding");
  entry.sha256 = "b".repeat(64);
  f.dispatch.inputStaging.push({ ...f.input, stagePath: "inputs/unbound" });
  expect(() => refreshDataCredentials(f.message, [f.next])).toThrow("authorized binding");
  f.dispatch.inputStaging.pop();
  const envelope = f.dispatch.sandboxExecution?.envelope;
  if (!envelope) throw new Error("Expected envelope");
  envelope.expiresAtUnixMs = 1n;
  expect(() => refreshDataCredentials(f.message, [f.next])).not.toThrow();
});
