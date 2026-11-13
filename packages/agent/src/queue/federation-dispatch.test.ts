import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { clone, create, toBinary } from "@bufbuild/protobuf";
import {
  DispatchJobSchema,
  dispatchIntent,
  InputStagingSchema,
  SandboxExecutionSchema,
  sameDispatchIntent,
} from "@kuintessence/proto";
import { federationDispatchReceipt, matchesFederationReceipt } from "./federation-dispatch";

test("restart fingerprint permits only the original renewable credentials", () => {
  const original = create(DispatchJobSchema, {
    jobId: "job",
    dispatchEpoch: 1n,
    federationExecution: true,
    command: "echo original",
    envVars: { Z: "secret", A: "value" },
    inputStaging: [
      create(InputStagingSchema, {
        stagePath: "input",
        sourceUrl: "https://test/old-secret",
        deliveryLeaseId: "lease",
        deliveryLeaseExpiresAtUnixMs: 1n,
      }),
      create(InputStagingSchema, { stagePath: "ordinary", sourceUrl: "https://test/fixed" }),
    ],
  });
  const receipt = federationDispatchReceipt(original);
  expect(JSON.stringify(receipt)).not.toContain("secret");
  const renewed = clone(DispatchJobSchema, original);
  renewed.envVars = { A: "value", Z: "secret" };
  const input = renewed.inputStaging[0];
  if (!input) throw new Error("missing fixture input");
  input.sourceUrl = "https://test/new-secret";
  input.deliveryLeaseId = "renewed";
  input.deliveryLeaseExpiresAtUnixMs = 2n;
  expect(matchesFederationReceipt(renewed, receipt)).toBe(true);
  expect(sameDispatchIntent(original, renewed)).toBe(true);
  const ordinary = renewed.inputStaging[1];
  if (!ordinary) throw new Error("missing ordinary input");
  ordinary.sourceUrl = "https://test/replaced";
  ordinary.deliveryLeaseId = "new-lease-source";
  expect(matchesFederationReceipt(renewed, receipt)).toBe(false);
  expect(sameDispatchIntent(original, renewed)).toBe(false);
});

test("Sandbox receipts opt into envelope renewal and retain legacy identity checks", () => {
  const original = create(DispatchJobSchema, {
    jobId: "sandbox",
    dispatchEpoch: 1n,
    federationExecution: true,
    sandboxExecution: create(SandboxExecutionSchema, {
      networkDisabled: true,
      envelope: { manifestSha256: "content", nonce: "original", expiresAtUnixMs: 1n },
    }),
  });
  const receipt = federationDispatchReceipt(original);
  const legacy = {
    ...receipt,
    renewableSandboxSignature: undefined,
    digest: createHash("sha256")
      .update(toBinary(DispatchJobSchema, dispatchIntent(original, [])))
      .digest("hex"),
  };
  const renewed = clone(DispatchJobSchema, original);
  if (!renewed.sandboxExecution?.envelope) throw new Error("Missing fixture");
  renewed.sandboxExecution.envelope.nonce = "renewed";
  renewed.sandboxExecution.envelope.expiresAtUnixMs = 2n;
  expect(matchesFederationReceipt(renewed, receipt)).toBe(true);
  expect(matchesFederationReceipt(original, legacy)).toBe(true);
  expect(matchesFederationReceipt(renewed, legacy)).toBe(false);
  renewed.sandboxExecution.networkDisabled = false;
  expect(matchesFederationReceipt(renewed, receipt)).toBe(false);
});
