import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { InputStagingSchema } from "@kuintessence/proto";
import { netdriveDeliveries } from "./netdrive-inputs";

function input() {
  return create(InputStagingSchema, {
    fileMetadataId: crypto.randomUUID(),
    netdriveInput: true,
    stagePath: "input.txt",
    expectedSha256: "a".repeat(64),
    totalBytes: 4n,
    sourceUrl: "https://objects.test/input",
    deliveryLeaseId: crypto.randomUUID(),
    deliveryLeaseExpiresAtUnixMs: BigInt(Date.now() + 60_000),
  });
}

test.each([
  "input.txt",
  "inputs/nested/input.txt",
])("NetDrive maps %s to a verified renewable delivery", (path) => {
  const staged = { ...input(), stagePath: path };
  const [binding] = netdriveDeliveries([staged]);
  expect(binding).toMatchObject({
    assetId: staged.fileMetadataId,
    versionId: staged.expectedSha256,
    stagePath: path === "input.txt" ? "." : "inputs/nested",
    leaseId: staged.deliveryLeaseId,
    leaseExpiresAtUnixMs: staged.deliveryLeaseExpiresAtUnixMs,
    selectedEntries: [
      {
        path: "input.txt",
        sha256: staged.expectedSha256,
        sizeBytes: 4n,
        objectDownloadUrl: staged.sourceUrl,
      },
    ],
  });
});

test.each([
  "",
  "/etc/passwd",
  "../escape",
  "input/../escape",
  "./input",
  "input//file",
  "input\\file",
  "input\0file",
])("NetDrive rejects unsafe path %j", (stagePath) => {
  expect(() => netdriveDeliveries([{ ...input(), stagePath }])).toThrow("immutable file binding");
});

test.each([
  "marker",
  "digest",
  "negative-size",
  "unsafe-size",
  "id",
])("NetDrive rejects invalid %s", (field) => {
  const staged = input();
  if (field === "marker") staged.netdriveInput = false;
  if (field === "digest") staged.expectedSha256 = "";
  if (field === "negative-size") staged.totalBytes = -1n;
  if (field === "unsafe-size") staged.totalBytes = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  if (field === "id") staged.fileMetadataId = "unbound";
  expect(() => netdriveDeliveries([staged])).toThrow("immutable file binding");
});
