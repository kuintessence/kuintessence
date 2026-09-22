import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { lstat, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { CaseId } from "./export-contract";
import { unchanged } from "./export-files";
import { runManagedHandoff } from "./managed-handoff";
import {
  encoded,
  type HandoffFixture,
  putHandoffFile,
  rejectHandoff,
  setHandoffResponses,
  withHandoffFixture,
} from "./managed-handoff.test-helpers";

const phases = ["prepare", "verify"] as const;
const receiptName = "web-binding.json";

async function configureWeb(fixture: HandoffFixture) {
  const expected = setHandoffResponses(fixture);
  const directory = join(fixture.work, "web-receipt");
  const path = join(directory, receiptName);
  const bytes = encoded(expected.binding);
  await putHandoffFile(path, bytes);
  fixture.options.webReceiptDirectory = directory;
  fixture.options.environment = {
    ...fixture.options.environment,
    KQ_ARTIFACT_IMPORT_MODE: "web",
  };
  return { ...expected, directory, path, bytes };
}

async function snapshotDirectory(directory: string) {
  const names = (await readdir(directory)).sort();
  return {
    names,
    stat: await lstat(directory, { bigint: true }),
    files: await Promise.all(
      names.map(async (name) => ({
        name,
        bytes: await readFile(join(directory, name)),
        stat: await lstat(join(directory, name), { bigint: true }),
      })),
    ),
  };
}

async function expectDirectoryUnchanged(
  directory: string,
  before: Awaited<ReturnType<typeof snapshotDirectory>>,
) {
  expect((await readdir(directory)).sort()).toEqual(before.names);
  expect(unchanged(before.stat, await lstat(directory, { bigint: true }))).toBe(true);
  for (const entry of before.files) {
    assert.deepEqual(await readFile(join(directory, entry.name)), entry.bytes);
    expect(unchanged(entry.stat, await lstat(join(directory, entry.name), { bigint: true }))).toBe(
      true,
    );
  }
}

function expectReadOnlyRequests(fixture: HandoffFixture) {
  const writes = fixture.requests.filter(({ init }) => init.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.url).toBe("http://server:3000/api/auth/login");
  expect(writes[0]?.init.method).toBe("POST");
  for (const { init } of fixture.requests) {
    expect(init.redirect).toBe("error");
    if (init.method === "GET") expect(init.body).toBeUndefined();
  }
  expect(new Set(fixture.requests.map(({ url }) => url))).toEqual(
    new Set(fixture.responses.keys()),
  );
}

for (const caseId of ["hello", "samtools"] satisfies CaseId[]) {
  test(`${caseId}: Web prepare and immutable verify require the exact browser binding`, async () => {
    await withHandoffFixture(caseId, async (fixture) => {
      const web = await configureWeb(fixture);
      const webBefore = await snapshotDirectory(web.directory);
      const receipt = await runManagedHandoff("prepare", fixture.options);
      expect(receipt.binding).toEqual(web.binding);
      expect(JSON.parse(await readFile(join(fixture.control, "bindings.json"), "utf8"))).toEqual({
        [fixture.release.spec]: web.binding,
      });
      assert.deepEqual(await readFile(join(fixture.control, "managed-lock.json")), fixture.lock);
      await expectDirectoryUnchanged(web.directory, webBefore);
      expectReadOnlyRequests(fixture);
      const controlBefore = await snapshotDirectory(fixture.control);
      fixture.requests.length = 0;
      expect(await runManagedHandoff("verify", fixture.options)).toEqual(receipt);
      await expectDirectoryUnchanged(fixture.control, controlBefore);
      await expectDirectoryUnchanged(web.directory, webBefore);
      expectReadOnlyRequests(fixture);
    });
  });
}

for (const mode of ["", "WEB", "auto", " bootstrap", "web "]) {
  for (const phase of phases) {
    test(`${phase}: rejects invalid import mode ${JSON.stringify(mode)} before IO`, async () => {
      await expect(
        runManagedHandoff(phase, {
          environment: {
            GITHUB_ACTIONS: "true",
            KQ_PR_TEST: "1",
            KQ_PR_SPACK_CASE: "hello",
            KQ_ARTIFACT_IMPORT_MODE: mode,
          },
          deliveryDirectory: "/missing-managed-handoff-delivery",
        }),
      ).rejects.toMatchObject({ stage: "guard", code: "SCHEMA_INVALID" });
    });
  }
}

for (const mode of [undefined, "bootstrap"]) {
  test(`bootstrap ${String(mode)} ignores Web receipt and retains catalog polling`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      fixture.options.environment = {
        ...fixture.options.environment,
        KQ_ARTIFACT_IMPORT_MODE: mode,
      };
      fixture.options.webReceiptDirectory = join(fixture.work, "missing-web-receipt");
      const { catalog } = setHandoffResponses(fixture);
      const fetcher = fixture.options.fetcher;
      assert(fetcher);
      let reads = 0;
      fixture.options.fetcher = async (url, init) => {
        if (url === catalog && ++reads === 1) {
          return new Response(encoded({ releases: [] }));
        }
        return fetcher(url, init);
      };
      await runManagedHandoff("prepare", fixture.options);
      expect(reads).toBe(3);
      await runManagedHandoff("verify", fixture.options);
      expect(reads).toBe(5);
      expect((await readdir(fixture.work)).sort()).toEqual(["control", "delivery"]);
    });
  });
}

const invalidReceipts = [
  "missing directory",
  "missing file",
  "malformed JSON",
  "malformed binding",
  "extra field",
  "empty",
  "oversize",
  "file symlink",
  "directory symlink",
] as const;

for (const phase of phases) {
  for (const invalid of invalidReceipts) {
    test(`${phase}: Web receipt ${invalid} fails before network without repair`, async () => {
      await withHandoffFixture("hello", async (fixture) => {
        const web = await configureWeb(fixture);
        if (phase === "verify") await runManagedHandoff("prepare", fixture.options);
        if (invalid === "missing directory") {
          await rm(web.directory, { recursive: true });
        } else if (invalid === "missing file") {
          await rm(web.path);
        } else if (invalid === "file symlink") {
          const target = join(fixture.work, "receipt-target.json");
          await putHandoffFile(target, web.bytes);
          await rm(web.path);
          await symlink(target, web.path);
        } else if (invalid === "directory symlink") {
          const target = join(fixture.work, "receipt-target");
          await rename(web.directory, target);
          await symlink(target, web.directory);
        } else {
          const bytes =
            invalid === "oversize"
              ? Buffer.concat([web.bytes, Buffer.alloc(64 * 1024, 32)])
              : invalid === "empty"
                ? Buffer.alloc(0)
                : invalid === "malformed JSON"
                  ? Buffer.from("synthetic-private-detail")
                  : invalid === "extra field"
                    ? encoded({ ...web.binding, extra: true })
                    : encoded({ repositoryId: web.binding.repositoryId });
          await putHandoffFile(web.path, bytes);
        }
        const controlBefore = await snapshotDirectory(fixture.control);
        const rootNames = (await readdir(fixture.work)).sort();
        const receiptStat =
          invalid === "missing directory" || invalid === "missing file"
            ? undefined
            : await lstat(web.path, { bigint: true });
        fixture.requests.length = 0;
        await rejectHandoff(fixture, phase, "web-receipt");
        expect(fixture.requests).toHaveLength(0);
        await expectDirectoryUnchanged(fixture.control, controlBefore);
        expect((await readdir(fixture.work)).sort()).toEqual(rootNames);
        if (receiptStat) {
          expect(unchanged(receiptStat, await lstat(web.path, { bigint: true }))).toBe(true);
        } else {
          await expect(lstat(web.path)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (invalid === "directory symlink") {
          expect((await lstat(web.directory)).isSymbolicLink()).toBe(true);
        }
      });
    });
  }

  for (const field of ["repositoryId", "manifestDigest"] as const) {
    test(`${phase}: Web receipt with a different ${field} cannot use catalog binding`, async () => {
      await withHandoffFixture("hello", async (fixture) => {
        const web = await configureWeb(fixture);
        if (phase === "verify") await runManagedHandoff("prepare", fixture.options);
        const value = field === "repositoryId" ? "f".repeat(64) : `sha256:${"f".repeat(64)}`;
        await putHandoffFile(web.path, encoded({ ...web.binding, [field]: value }));
        const before = await snapshotDirectory(web.directory);
        const controlBefore = await snapshotDirectory(fixture.control);
        fixture.requests.length = 0;
        await rejectHandoff(fixture, phase, "catalog");
        expect(fixture.requests.map(({ url }) => url)).toEqual([
          "http://server:3000/api/auth/login",
          web.catalog,
        ]);
        await expectDirectoryUnchanged(web.directory, before);
        await expectDirectoryUnchanged(fixture.control, controlBefore);
      });
    });
  }

  test(`${phase}: Web empty catalog fails immediately without bootstrap polling`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const web = await configureWeb(fixture);
      if (phase === "verify") await runManagedHandoff("prepare", fixture.options);
      const before = await snapshotDirectory(fixture.control);
      const fetcher = fixture.options.fetcher;
      assert(fetcher);
      let reads = 0;
      fixture.options.fetcher = async (url, init) => {
        if (url === web.catalog && ++reads === 1) {
          return new Response(encoded({ releases: [] }));
        }
        return fetcher(url, init);
      };
      await rejectHandoff(fixture, phase, "catalog");
      expect(reads).toBe(1);
      await expectDirectoryUnchanged(fixture.control, before);
    });
  });

  for (const mutation of ["bytes", "identical replacement", "directory replacement", "symlink"]) {
    test(`${phase}: Web receipt ${mutation} during remote readback rejects handoff`, async () => {
      await withHandoffFixture("hello", async (fixture) => {
        const web = await configureWeb(fixture);
        if (phase === "verify") await runManagedHandoff("prepare", fixture.options);
        const before = await snapshotDirectory(fixture.control);
        const fetcher = fixture.options.fetcher;
        assert(fetcher);
        let reads = 0;
        fixture.options.fetcher = async (url, init) => {
          if (url === web.catalog && ++reads === 2) {
            if (mutation === "bytes") {
              await putHandoffFile(web.path, Buffer.concat([web.bytes, Buffer.from(" ")]));
            } else if (mutation === "directory replacement") {
              await rename(web.directory, join(fixture.work, "previous-receipt"));
              await putHandoffFile(web.path, web.bytes);
            } else {
              const target = join(fixture.work, "replacement.json");
              await putHandoffFile(target, web.bytes);
              if (mutation === "symlink") {
                await rm(web.path);
                await symlink(target, web.path);
              } else {
                await rename(target, web.path);
              }
            }
          }
          return fetcher(url, init);
        };
        await rejectHandoff(fixture, phase, "web-receipt");
        expect(reads).toBe(2);
        await expectDirectoryUnchanged(fixture.control, before);
        assert.deepEqual(
          await readFile(web.path),
          mutation === "bytes" ? Buffer.concat([web.bytes, Buffer.from(" ")]) : web.bytes,
        );
        expect((await lstat(web.path)).isSymbolicLink()).toBe(mutation === "symlink");
      });
    });
  }
}
