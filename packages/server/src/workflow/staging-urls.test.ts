import { describe, expect, test } from "bun:test";
import { attachStagingUrls } from "./staging-urls";

describe("attachStagingUrls", () => {
  test("presigns a source URL for each staged file, preserving stagePath", async () => {
    const out = await attachStagingUrls(
      [
        { fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" },
        { fileMetadataId: "fm-2", stagePath: "case/0/U" },
      ],
      async (id) => `https://minio.local/get/${id}?sig=x`,
    );
    expect(out).toEqual([
      {
        fileMetadataId: "fm-1",
        stagePath: "mesh.tar.gz",
        sourceUrl: "https://minio.local/get/fm-1?sig=x",
      },
      {
        fileMetadataId: "fm-2",
        stagePath: "case/0/U",
        sourceUrl: "https://minio.local/get/fm-2?sig=x",
      },
    ]);
  });

  test("returns an empty list unchanged", async () => {
    expect(await attachStagingUrls([], async () => "x")).toEqual([]);
  });
});
