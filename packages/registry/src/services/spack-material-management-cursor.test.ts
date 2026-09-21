import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SpackMaterialManagementCursorSchema } from "@kuintessence/shared";
import { managementCursor } from "./spack-material-management-cursor";

const secret = "management-cursor-fixture-only-0000000";
const subject = "55555555-5555-4555-8555-555555555555";
const query = { repository: "public/materials", state: "all", limit: 10 } as const;
const digest = `sha256:${"b".repeat(64)}`;
const now = Date.now;
afterEach(() => {
  Date.now = now;
});

describe("encrypted management cursors", () => {
  test("round trips across replicas without disclosing candidate digest or subject", () => {
    const cursor = managementCursor(secret, subject, query).encode(digest);
    expect(SpackMaterialManagementCursorSchema.safeParse(cursor).success).toBe(true);
    expect(managementCursor(secret, subject, query).decode(cursor)).toBe(digest);
    expect(cursor).not.toContain(digest);
    expect(Buffer.from(cursor.slice(3), "base64url").toString("utf8")).not.toContain(subject);
  });

  test.each(["subject", "repository", "state", "limit", "secret"])(
    "rejects a cursor reused with another %s",
    (field) => {
      const cursor = managementCursor(secret, subject, query).encode(digest);
      const codec = managementCursor(
        field === "secret" ? `${secret}x` : secret,
        field === "subject" ? "someone-else" : subject,
        {
          ...query,
          ...(field === "repository" ? { repository: "public/other" } : {}),
          ...(field === "state" ? { state: "withdrawn" as const } : {}),
          ...(field === "limit" ? { limit: 5 } : {}),
        },
      );
      expect(() => codec.decode(cursor)).toThrow("Invalid or expired management cursor");
    },
  );

  test("rejects corruption, raw digests and oversized cursors", () => {
    const codec = managementCursor(secret, subject, query);
    const cursor = codec.encode(digest);
    const bytes = Buffer.from(cursor.slice(3), "base64url");
    bytes[15] = (bytes[15] ?? 0) ^ 1;
    for (const invalid of [digest, `v1.${bytes.toString("base64url")}`, `v1.${"a".repeat(513)}`]) {
      expect(() => codec.decode(invalid)).toThrow("Invalid or expired management cursor");
    }
  });

  test("expires after fifteen minutes and refuses missing configuration", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const codec = managementCursor(secret, subject, query);
    const cursor = codec.encode(digest);
    clock.mockReturnValue(1_800_000_900_000);
    expect(() => codec.decode(cursor)).toThrow("Invalid or expired management cursor");
    expect(() => managementCursor("", subject, query)).toThrow("not configured");
    clock.mockRestore();
  });
});
