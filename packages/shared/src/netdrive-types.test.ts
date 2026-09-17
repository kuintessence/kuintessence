import { describe, expect, test } from "bun:test";
import {
  NetDriveMultipartCompleteRequestSchema,
  NetDriveMultipartInitRequestSchema,
  NetDrivePartUrlsRequestSchema,
} from "./netdrive-types";

describe("NetDrive multipart schemas", () => {
  test("init request accepts a valid body", () => {
    const parsed = NetDriveMultipartInitRequestSchema.parse({
      path: "outputs/run1/big.dat",
      size: 5_000_000_000,
      contentType: "application/octet-stream",
    });
    expect(parsed.size).toBe(5_000_000_000);
  });

  test("init request rejects a traversal path", () => {
    expect(() =>
      NetDriveMultipartInitRequestSchema.parse({ path: "../etc/passwd", size: 1 }),
    ).toThrow();
  });

  test("part-urls request requires at least one positive part number", () => {
    expect(() =>
      NetDrivePartUrlsRequestSchema.parse({
        storageKey: "netdrive/o/u",
        uploadId: "up",
        commitToken: "t",
        partNumbers: [],
      }),
    ).toThrow();
    expect(() =>
      NetDrivePartUrlsRequestSchema.parse({
        storageKey: "netdrive/o/u",
        uploadId: "up",
        commitToken: "t",
        partNumbers: [0],
      }),
    ).toThrow();
    const ok = NetDrivePartUrlsRequestSchema.parse({
      storageKey: "netdrive/o/u",
      uploadId: "up",
      commitToken: "t",
      partNumbers: [1, 2, 3],
    });
    expect(ok.partNumbers).toEqual([1, 2, 3]);
  });

  test("complete request requires ordered part refs + sha256", () => {
    const ok = NetDriveMultipartCompleteRequestSchema.parse({
      path: "outputs/run1/big.dat",
      size: 10,
      sha256: "a".repeat(64),
      storageKey: "netdrive/o/u",
      uploadId: "up",
      commitToken: "t",
      parts: [
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
      ],
    });
    expect(ok.parts).toHaveLength(2);
    expect(() =>
      NetDriveMultipartCompleteRequestSchema.parse({
        path: "outputs/run1/big.dat",
        size: 10,
        sha256: "nothex",
        storageKey: "netdrive/o/u",
        uploadId: "up",
        commitToken: "t",
        parts: [{ partNumber: 1, etag: "e1" }],
      }),
    ).toThrow();
  });
});
