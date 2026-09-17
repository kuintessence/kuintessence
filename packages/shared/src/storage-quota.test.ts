import { describe, expect, test } from "bun:test";
import {
  StorageQuotaGrantCreateSchema,
  StorageQuotaPolicyInputSchema,
  StorageQuotaRequestCreateSchema,
} from "./storage-quota";

describe("storage quota contracts", () => {
  test("keeps the cloud drive as one global scope", () => {
    const request = StorageQuotaRequestCreateSchema.safeParse({
      scope: "cloud",
      scopeId: "another-drive",
      requestedQuotaBytes: 1024,
      reason: "more space",
    });
    const grant = StorageQuotaGrantCreateSchema.safeParse({
      userId: "00000000-0000-0000-0000-000000000001",
      scope: "cloud",
      scopeId: "another-drive",
      quotaBytes: 1024,
    });

    expect(request.success).toBe(false);
    expect(grant.success).toBe(false);
  });

  test("rejects policy limits that contradict the maximum quota", () => {
    const result = StorageQuotaPolicyInputSchema.safeParse({
      scope: "cloud",
      scopeId: "global",
      defaultQuotaBytes: 10,
      maxQuotaBytes: 20,
      requestMode: "auto",
      autoApproveLimitBytes: 30,
      enabled: true,
    });

    expect(result.success).toBe(false);
  });
});
