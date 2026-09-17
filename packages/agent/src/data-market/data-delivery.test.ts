import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DataDeliveryBindingSchema,
  DataDeliveryEntrySchema,
  DataDeliveryMethod,
} from "@kuintessence/proto";
import { DataDeliveryExecutor, type TrustedReadonlyMountDriver } from "./data-delivery";
import { AgentDataRoots } from "./local-data-security";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-data-delivery-"));
  temporaryRoots.push(root);
  const datasetRoot = join(root, "datasets");
  const jobRoot = join(root, "jobs");
  await Promise.all([mkdir(join(datasetRoot, "managed"), { recursive: true }), mkdir(jobRoot)]);
  await Promise.all([
    chmod(datasetRoot, 0o700),
    chmod(jobRoot, 0o700),
    chmod(join(datasetRoot, "managed"), 0o700),
  ]);
  const roots = new AgentDataRoots({
    datasetRoot,
    managedRoots: { "11111111-1111-4111-8111-111111111111": "managed" },
    jobWorkRoot: jobRoot,
  });
  await roots.initialize();
  return { root, datasetRoot, jobRoot, roots };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(input: {
  method: DataDeliveryMethod;
  entries: Array<{ path: string; value: string; url?: string }>;
  restricted?: boolean;
}) {
  return create(DataDeliveryBindingSchema, {
    bindingId: "binding-1",
    locationId: "location-1",
    assetId: "asset-1",
    versionId: "version-1",
    manifestDigest: "manifest-1",
    stagePath: "inputs/dataset",
    method: input.method,
    managedRootId:
      input.method === DataDeliveryMethod.OBJECT_DOWNLOAD
        ? ""
        : "11111111-1111-4111-8111-111111111111",
    relativePath: input.method === DataDeliveryMethod.OBJECT_DOWNLOAD ? "" : ".",
    restricted: input.restricted ?? false,
    leaseId: "11111111-1111-4111-8111-111111111111",
    leaseExpiresAtUnixMs: BigInt(Date.now() + 60_000),
    selectedEntries: input.entries.map((entry) =>
      create(DataDeliveryEntrySchema, {
        path: entry.path,
        sha256: digest(entry.value),
        sizeBytes: BigInt(entry.value.length),
        objectDownloadUrl: entry.url ?? "",
      }),
    ),
  });
}

describe("DataDeliveryExecutor", () => {
  test("downloads every selected object entry into the Agent job root", async () => {
    const { roots, jobRoot } = await fixture();
    const events: string[] = [];
    const payloads = new Map([
      ["https://object.test/a", "alpha"],
      ["https://object.test/b", "beta"],
    ]);
    const executor = new DataDeliveryExecutor({
      roots,
      fetchImpl: (async (url: string | URL | Request) => {
        events.push(`download:${url}`);
        return new Response(payloads.get(String(url)), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await executor.prepare(
      "job-1",
      [
        binding({
          method: DataDeliveryMethod.OBJECT_DOWNLOAD,
          entries: [
            { path: "first.txt", value: "alpha", url: "https://object.test/a" },
            { path: "nested/second.txt", value: "beta", url: "https://object.test/b" },
          ],
        }),
      ],
      {
        beforeSideEffect: async (cleanup) => {
          events.push(`intent:${cleanup.targetPath}`);
          await expect(readFile(cleanup.targetPath)).rejects.toThrow();
        },
      },
    );
    expect(await readFile(join(jobRoot, "job-1", "inputs/dataset/first.txt"), "utf8")).toBe(
      "alpha",
    );
    expect(await readFile(join(jobRoot, "job-1", "inputs/dataset/nested/second.txt"), "utf8")).toBe(
      "beta",
    );
    expect(events[0]).toContain("intent:");
    expect(events[1]).toBe("download:https://object.test/a");
  });

  test("fails closed before downloading when the delivery lease has expired", async () => {
    const { roots } = await fixture();
    const executor = new DataDeliveryExecutor({ roots, now: () => 1_000 });
    const expired = binding({
      method: DataDeliveryMethod.OBJECT_DOWNLOAD,
      entries: [{ path: "input", value: "content", url: "https://object.test/input" }],
    });
    expired.leaseExpiresAtUnixMs = 999n;
    await expect(executor.prepare("job-expired", [expired])).rejects.toThrow("lease has expired");
  });

  test("copies CP-local files without accepting a symlink source", async () => {
    const { datasetRoot, roots, jobRoot } = await fixture();
    await writeFile(join(datasetRoot, "managed", "input.dat"), "copy-me");
    const executor = new DataDeliveryExecutor({ roots });
    await executor.prepare("job-2", [
      binding({
        method: DataDeliveryMethod.STAGE_COPY,
        entries: [{ path: "input.dat", value: "copy-me" }],
      }),
    ]);
    expect(await readFile(join(jobRoot, "job-2", "inputs/dataset/input.dat"), "utf8")).toBe(
      "copy-me",
    );
  });

  test("uses a trusted readonly driver for restricted CP-local data and removes it on release", async () => {
    const { datasetRoot, roots } = await fixture();
    await writeFile(join(datasetRoot, "managed", "potcar"), "restricted");
    const mounted: string[] = [];
    const driver: TrustedReadonlyMountDriver = {
      trusted: true,
      mountReadonly: async (_source, target) => {
        mounted.push(`mount:${target}`);
      },
      unmount: async (target) => {
        mounted.push(`unmount:${target}`);
      },
    };
    const executor = new DataDeliveryExecutor({ roots, readonlyMountDriver: driver });
    await executor.prepare("job-3", [
      binding({
        method: DataDeliveryMethod.READONLY_MOUNT,
        restricted: true,
        entries: [{ path: "potcar", value: "restricted" }],
      }),
    ]);
    await executor.release("job-3");
    expect(mounted).toHaveLength(2);
    expect(mounted[0] ?? "").toContain("mount:");
    expect(mounted[0] ?? "").toEndWith("/jobs/job-3/inputs/dataset/potcar");
    expect(mounted[1] ?? "").toContain("unmount:");
    expect(mounted[1] ?? "").toEndWith("/jobs/job-3/inputs/dataset/potcar");
  });

  test("rolls back the first entry when a later entry fails verification", async () => {
    const { roots, jobRoot } = await fixture();
    const executor = new DataDeliveryExecutor({
      roots,
      fetchImpl: (async (url: string | URL | Request) =>
        new Response(String(url).endsWith("first") ? "first" : "tampered", {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(
      executor.prepare("job-4", [
        binding({
          method: DataDeliveryMethod.OBJECT_DOWNLOAD,
          entries: [
            { path: "first", value: "first", url: "https://object.test/first" },
            { path: "second", value: "second", url: "https://object.test/second" },
          ],
        }),
      ]),
    ).rejects.toThrow("exceeds");
    await expect(readFile(join(jobRoot, "job-4", "inputs/dataset/first"))).rejects.toThrow();
  });

  test("rejects an existing symlink target before CP-local stage-copy", async () => {
    const { root, datasetRoot, roots, jobRoot } = await fixture();
    await writeFile(join(datasetRoot, "managed", "input.dat"), "copy-me");
    await roots.prepareJobRoot("job-5");
    const targetDirectory = join(jobRoot, "job-5", "inputs/dataset");
    await mkdir(targetDirectory, { recursive: true });
    await symlink(join(root, "outside"), join(targetDirectory, "input.dat"));
    const executor = new DataDeliveryExecutor({ roots });
    await expect(
      executor.prepare("job-5", [
        binding({
          method: DataDeliveryMethod.STAGE_COPY,
          entries: [{ path: "input.dat", value: "copy-me" }],
        }),
      ]),
    ).rejects.toThrow("must not already exist");
  });
});
