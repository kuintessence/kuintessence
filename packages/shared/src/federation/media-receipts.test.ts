import { expect, test } from "bun:test";
import {
  assertMediaReceiptAck,
  FederationMediaReceiptAckSchema,
  FederationMediaReceiptSchema,
} from "./media-receipts";
import { FederationKeyInput } from "./trust";

test("media import receipts are historical custody facts with separately authorized signing purposes", () => {
  const receipt = FederationMediaReceiptSchema.parse({
    protocolVersion: 1,
    kind: "media-import-receipt",
    receiptId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    keyQueryId: crypto.randomUUID(),
    keyQueryDigest: `sha256:${"b".repeat(64)}`,
    state: "verified-private",
    fileCount: 1,
    sizeBytes: 4,
    receivedAt: "2026-01-01T00:00:00Z",
  });
  const now = new Date("2026-01-02T00:00:00Z"),
    digest = `sha256:${"c".repeat(64)}`;
  const ack = FederationMediaReceiptAckSchema.parse({
    protocolVersion: 1,
    kind: "media-import-receipt-ack",
    receiptId: receipt.receiptId,
    packageId: receipt.packageId,
    senderSiteId: receipt.recipientSiteId,
    recipientSiteId: receipt.senderSiteId,
    receiptDigest: digest,
    recordedAt: now.toISOString(),
  });
  expect(() => assertMediaReceiptAck(receipt, digest, ack, now)).not.toThrow();
  for (const patch of [
    { receiptId: crypto.randomUUID() },
    { packageId: crypto.randomUUID() },
    { receiptDigest: receipt.manifestDigest },
    { senderSiteId: receipt.senderSiteId },
    { recordedAt: "2026-01-03T00:00:00Z" },
  ])
    expect(() => assertMediaReceiptAck(receipt, digest, { ...ack, ...patch }, now)).toThrow();
  for (const patch of [
    { state: "available" },
    { userId: crypto.randomUUID() },
    { fileCount: 0 },
    { sizeBytes: -1 },
    { senderSiteId: receipt.recipientSiteId },
  ])
    expect(FederationMediaReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  expect(kinds).toContain("media-import-receipt");
  expect(kinds).toContain("media-import-receipt-ack");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
