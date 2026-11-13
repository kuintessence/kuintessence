import { expect, test } from "bun:test";
import {
  ReservationPolicyInputSchema,
  ReservationPolicySchema,
  TerminalPolicyInputSchema,
  TerminalPolicySchema,
} from "./commercial";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = {
  maxTaskAmount: "9007199254740993",
  maxTotalAmount: "9007199254740999",
  maxTasks: 10,
  validUntil: "2099-01-01T00:00:00Z",
};
const record = {
  id,
  localSiteId: id,
  localOrgId: id,
  agreementRevisionId: id,
  agreementDigest: `sha256:${"a".repeat(64)}`,
  validFrom: "2026-01-01T00:00:00Z",
  grantedBy: id,
  revokedAt: null,
  revokedBy: null,
};
const policy = {
  ...record,
  ...input,
  allowMarketPublish: false,
  allowMarketClaim: false,
  allowActivation: false,
  allowExecutionConfirmation: false,
  authorizedAmount: "9007199254740993",
  authorizedTasks: 1,
};

test("shared policy input preserves legacy defaults and exact large amounts", () => {
  expect(ReservationPolicyInputSchema.parse(input)).toEqual({
    ...input,
    allowMarketPublish: false,
    allowMarketClaim: false,
    allowActivation: false,
    allowExecutionConfirmation: false,
  });
  expect(ReservationPolicySchema.parse(policy).authorizedAmount).toBe("9007199254740993");
});

test("policy input cannot accept extra authority or invalid limits", () => {
  for (const patch of [
    { approvedBy: id },
    { maxTasks: 0 },
    { maxTaskAmount: "9007199254741000" },
    { maxTaskAmount: 12 },
  ])
    expect(ReservationPolicyInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  expect(
    TerminalPolicyInputSchema.safeParse({
      outcomes: ["completed", "completed"],
      validUntil: input.validUntil,
    }).success,
  ).toBe(false);
  expect(
    TerminalPolicyInputSchema.safeParse({ outcomes: [], validUntil: input.validUntil }).success,
  ).toBe(false);
});

test("persisted policy views reject missing permission flags, inconsistent revocation and counters", () => {
  for (const patch of [
    { allowActivation: undefined },
    { revokedAt: input.validUntil },
    { authorizedAmount: "9007199254741000" },
    { authorizedTasks: 11 },
    { marketAuthorizedTasks: 11 },
    { marketAuthorizedAmount: "9007199254741000" },
    { validFrom: input.validUntil },
  ])
    expect(ReservationPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
  expect(
    TerminalPolicySchema.safeParse({
      ...record,
      outcomes: ["failed"],
      validUntil: input.validUntil,
    }).success,
  ).toBe(true);
});
