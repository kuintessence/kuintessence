import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { DispatchJobSchema, InputStagingSchema, sameDispatchIntent } from "@kuintessence/proto";
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
