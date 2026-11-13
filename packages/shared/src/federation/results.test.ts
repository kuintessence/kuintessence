import { expect, test } from "bun:test";
import {
  assertFederationReportIdentity,
  FederationResultManifestSchema,
  FederationResultPolicySchema,
  FederationResultQuerySchema,
  FederationResultReportSchema,
} from "./index";

const digest = `sha256:${"a".repeat(64)}`;
const time = "2026-01-01T00:00:00.000Z";
const file = { path: "nested/result.dat", sha256: "a".repeat(64), sizeBytes: 3 };
const output = {
  outputId: digest,
  nodeId: "calculate",
  descriptor: "result",
  type: "File" as const,
  contentDigest: digest,
  sizeBytes: 3,
  files: [file],
};
const manifest = {
  template: {
    originSiteId: crypto.randomUUID(),
    kind: "workflow" as const,
    id: crypto.randomUUID(),
    revision: "1",
    digest,
  },
  inputManifestDigest: digest,
  environmentLockDigest: digest,
  completedAt: time,
  availableUntil: "2026-01-02T00:00:00.000Z",
  outputs: [output],
};

test("result manifests reject unsafe paths, duplicate or incomplete members and unexpected credentials", () => {
  expect(FederationResultManifestSchema.parse(manifest)).toEqual(manifest);
  for (const path of ["/etc/passwd", "../x", "x/../y", "x\\y", "x\nname", "x//y", "."])
    expect(
      FederationResultManifestSchema.safeParse({
        ...manifest,
        outputs: [{ ...output, files: [{ ...file, path }] }],
      }).success,
    ).toBe(false);
  for (const changed of [
    { files: [] },
    { files: [file, file] },
    { sizeBytes: 4 },
    { files: [{ ...file, sha256: "b".repeat(64) }] },
    { files: [{ ...file, downloadUrl: "https://private.invalid/token" }] },
  ])
    expect(
      FederationResultManifestSchema.safeParse({
        ...manifest,
        outputs: [{ ...output, ...changed }],
      }).success,
    ).toBe(false);
  expect(
    FederationResultManifestSchema.safeParse({ ...manifest, outputs: [output, output] }).success,
  ).toBe(false);
  expect(
    FederationResultPolicySchema.safeParse({
      scope: "persistent-files",
      maxFiles: 257,
      maxBytes: 3,
      availableUntil: time,
    }).success,
  ).toBe(false);
});

test("result reports bind the same fresh query identity without accepting status messages", () => {
  const query = FederationResultQuerySchema.parse({
    protocolVersion: 1,
    kind: "result-query",
    queryId: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    attempt: 1,
    reservationId: crypto.randomUUID(),
    requestDigest: digest,
    issuedAt: time,
    expiresAt: "2026-01-01T00:01:00.000Z",
  });
  const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...identity } = query;
  const report = FederationResultReportSchema.parse({
    ...identity,
    kind: "result-report",
    senderSiteId: query.recipientSiteId,
    recipientSiteId: query.senderSiteId,
    queryDigest: digest,
    manifestDigest: digest,
    manifest,
    observedAt: time,
  });
  assertFederationReportIdentity(query, digest, report, new Date(time));
  expect(() =>
    assertFederationReportIdentity(
      query,
      digest,
      { ...report, queryId: crypto.randomUUID() },
      new Date(time),
    ),
  ).toThrow("INVALID_MESSAGE");
  expect(() =>
    assertFederationReportIdentity(query, digest, report, new Date(query.expiresAt)),
  ).toThrow("AUTHORIZATION_EXPIRED");
  expect(FederationResultQuerySchema.safeParse({ ...query, kind: "status-query" }).success).toBe(
    false,
  );
});
