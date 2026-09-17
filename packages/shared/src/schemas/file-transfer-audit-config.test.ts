import { describe, expect, test } from "bun:test";
import {
  FileTransferAuditConfigUpdateSchema,
  FileTransferAuditConfigViewSchema,
} from "./file-transfer-audit-config";

describe("FileTransferAuditConfigUpdateSchema", () => {
  test("accepts the recommended production defaults", () => {
    expect(
      FileTransferAuditConfigUpdateSchema.parse({
        userPlatformRetentionDays: 365,
        platformClusterRetentionDays: 180,
        downloadEvidenceMode: "controlled_gateway",
        changeReason: "采用平台默认审计策略",
      }),
    ).toEqual({
      userPlatformRetentionDays: 365,
      platformClusterRetentionDays: 180,
      downloadEvidenceMode: "controlled_gateway",
      changeReason: "采用平台默认审计策略",
    });
  });

  test("rejects unsafe shapes and requires a recorded reason", () => {
    expect(() =>
      FileTransferAuditConfigUpdateSchema.parse({
        userPlatformRetentionDays: 0,
        platformClusterRetentionDays: 180,
        downloadEvidenceMode: "completed_without_evidence",
        changeReason: "x",
      }),
    ).toThrow();
  });
});

describe("FileTransferAuditConfigViewSchema", () => {
  test("keeps policy-version metadata out of update inputs", () => {
    const view = FileTransferAuditConfigViewSchema.parse({
      userPlatformRetentionDays: 365,
      platformClusterRetentionDays: 180,
      downloadEvidenceMode: "direct_authorization_only",
      policyVersion: 3,
      updatedAt: "2026-09-02T04:46:52.000Z",
      updatedBy: "operator-1",
    });
    expect(view.policyVersion).toBe(3);
    expect(view.downloadEvidenceMode).toBe("direct_authorization_only");
  });
});
