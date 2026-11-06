import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { sameDispatchIntent } from "./dispatch-intent";
import { DispatchJobSchema } from "./generated/kuintessence/v1/agent_service_pb";

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
