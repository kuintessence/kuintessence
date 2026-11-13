import { expect, test } from "bun:test";
import { ReservationProposalReceiptSchema } from "./reservation-proposal";
import { FederationKeyInput } from "./trust";

test("reservation proposal receipt binds the original digest without exposing private terms or authorizing execution", () => {
  const receipt = {
    protocolVersion: 1,
    kind: "reservation-proposal-receipt",
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    reservationId: crypto.randomUUID(),
    proposalDigest: `sha256:${"a".repeat(64)}`,
    receivedAt: new Date().toISOString(),
  };
  expect(ReservationProposalReceiptSchema.safeParse(receipt).success).toBe(true);
  for (const patch of [
    { proposalDigest: "unknown" },
    { approved: true },
    { amount: "100" },
    { senderSiteId: receipt.recipientSiteId },
  ])
    expect(ReservationProposalReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(
      false,
    );
  const purposes = FederationKeyInput.shape.allowedKinds.element.options;
  expect(purposes).toContain("reservation-proposal-receipt");
  expect(FederationKeyInput.shape.allowedKinds.safeParse(purposes).success).toBe(true);
});
