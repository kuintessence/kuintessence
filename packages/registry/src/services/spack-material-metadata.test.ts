import { afterEach, expect, test } from "bun:test";
import { appendFileSync, truncateSync } from "node:fs";
import { rename, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupMaterials, materialFixture } from "../routes/spack-materials.test-helpers";
import {
  MATERIAL_METADATA_BYTES,
  readMaterialMetadata,
  SpackMaterialError,
} from "./spack-material-storage";

afterEach(cleanupMaterials);

test("metadata read stays on the checked file handle after pathname replacement", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  const moved = join(f.root, "original.json");
  const original = '{"state":"original"}';
  await writeFile(path, original);
  let checks = 0;
  const bytes = await readMaterialMetadata(path, {
    validatePath: async () => {
      if (++checks === 2) {
        await rename(path, moved);
        await writeFile(path, '{"state":"replacement"}');
      }
    },
  });
  expect(bytes.toString()).toBe(original);
});

test("metadata never follows a leaf symlink", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  const link = join(f.root, "link.json");
  await writeFile(path, "{}");
  await symlink(path, link);
  await expect(readMaterialMetadata(link)).rejects.toMatchObject({ status: 500 });
});

test("same-handle size validation happens before allocating or reading metadata", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  await writeFile(path, "not JSON but too large for this query");
  const budgetError = new SpackMaterialError(503, "budget");
  await expect(
    readMaterialMetadata(path, {
      checkSize: (size) => {
        if (size > 1) throw budgetError;
      },
    }),
  ).rejects.toBe(budgetError);
});

test("growing metadata after fstat is detected without reading unbounded appended bytes", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  await writeFile(path, "{}");
  let grew = false;
  const budgetError = new SpackMaterialError(503, "budget");
  await expect(
    readMaterialMetadata(path, {
      checkSize: (size) => {
        if (size > 2) throw budgetError;
        if (!grew) {
          grew = true;
          appendFileSync(path, "x".repeat(MATERIAL_METADATA_BYTES));
        }
      },
    }),
  ).rejects.toBe(budgetError);
});

test("truncated metadata fails without returning a partial body", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  await writeFile(path, "{}");
  await expect(
    readMaterialMetadata(path, {
      checkSize: () => truncateSync(path, 1),
    }),
  ).rejects.toMatchObject({ status: 500, message: "Truncated material metadata" });
});

test("metadata larger than the format ceiling is rejected", async () => {
  const f = await materialFixture();
  const path = join(f.root, "metadata.json");
  await writeFile(path, "{}");
  await truncate(path, MATERIAL_METADATA_BYTES + 1);
  await expect(readMaterialMetadata(path)).rejects.toMatchObject({ status: 500 });
});

test("cancellation before a metadata read preserves the original reason", async () => {
  const f = await materialFixture();
  const reason = new Error("stop");
  await expect(
    readMaterialMetadata(join(f.root, "not-created.json"), {
      checkpoint: () => {
        throw reason;
      },
    }),
  ).rejects.toBe(reason);
});
