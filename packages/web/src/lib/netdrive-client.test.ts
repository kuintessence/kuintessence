import type { NetDriveListItem } from "@kuintessence/shared/browser";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./api-client";
import { listAllNetDriveFiles } from "./netdrive-client";

vi.mock("./api-client", () => ({
  api: { get: vi.fn() },
}));

function file(id: string): NetDriveListItem {
  return {
    id,
    ownerId: "00000000-0000-4000-8000-000000000001",
    path: `${id}.dat`,
    size: 1,
    sha256: "a".repeat(64),
    contentType: "application/octet-stream",
    etag: null,
    storageKey: `netdrive/${id}`,
    mtime: "2026-08-12T00:00:00.000Z",
    createdAt: "2026-08-12T00:00:00.000Z",
    canUse: true,
    canDelete: true,
  };
}

afterEach(() => vi.clearAllMocks());

describe("listAllNetDriveFiles", () => {
  test("loads subsequent pages until every visible file is available", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("first")], total: 3, limit: 1, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("second"), file("third")], total: 3, limit: 500, offset: 1 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("first")], total: 3, limit: 1, offset: 0 },
      });

    const result = await listAllNetDriveFiles();

    expect(api.get).toHaveBeenNthCalledWith(1, "/netdrive/files");
    expect(api.get).toHaveBeenNthCalledWith(3, "/netdrive/files");
    expect(result.data.files.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  test("restarts when offset pagination overlaps after a concurrent insertion", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("second")], total: 2, limit: 1, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("second")], total: 2, limit: 500, offset: 1 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("second"), file("first")], total: 2, limit: 2, offset: 0 },
      });

    expect((await listAllNetDriveFiles()).data.files.map((item) => item.id)).toEqual([
      "second",
      "first",
    ]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  test("fails instead of returning an incomplete list when no stable snapshot is observed", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("first")], total: 2, limit: 1, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [], total: 1, limit: 500, offset: 1 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("second")], total: 2, limit: 1, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [], total: 1, limit: 500, offset: 1 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [file("third")], total: 2, limit: 1, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { files: [], total: 1, limit: 500, offset: 1 },
      });

    await expect(listAllNetDriveFiles()).rejects.toThrow("changed while loading");
  });

  test("rejects list items whose capability contract is missing", async () => {
    const item = file("first");
    const { canUse: _canUse, ...withoutCanUse } = item;
    vi.mocked(api.get).mockResolvedValueOnce({
      success: true,
      data: { files: [withoutCanUse], total: 1, limit: 1, offset: 0 },
    });

    await expect(listAllNetDriveFiles()).rejects.toThrow();
  });
});
