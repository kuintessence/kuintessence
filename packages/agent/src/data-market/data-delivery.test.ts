import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clone, create } from "@bufbuild/protobuf";
import {
  DataDeliveryBindingSchema,
  DataDeliveryEntrySchema,
  DataDeliveryMethod,
  InputStagingSchema,
} from "@kuintessence/proto";
import { ExecutionAuthorization } from "../execution-authorization";
import {
  DataDeliveryExecutor,
  LinuxBindReadonlyMountDriver,
  type TrustedReadonlyMountDriver,
} from "./data-delivery";
import { AgentDataRoots } from "./local-data-security";
import { netdriveDeliveries } from "./netdrive-inputs";

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

test("renews expired object credentials before transfer and after a long transfer", async () => {
  const { roots, jobRoot } = await fixture();
  let now = 1_000;
  let renewals = 0;
  const executor = new DataDeliveryExecutor({
    roots,
    now: () => now,
    fetchImpl: (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://object.test/renewed-2");
      now = 10_000;
      return new Response("content");
    }) as unknown as typeof fetch,
  });
  const expired = binding({
    method: DataDeliveryMethod.OBJECT_DOWNLOAD,
    entries: [{ path: "input", value: "content", url: "https://object.test/expired" }],
  });
  expired.leaseExpiresAtUnixMs = 999n;
  await executor.prepare("renewed-job", [expired], {
    renew: async (previous) => {
      renewals++;
      const current = clone(DataDeliveryBindingSchema, previous);
      current.leaseExpiresAtUnixMs = BigInt(now + 1000);
      for (const entry of current.selectedEntries)
        entry.objectDownloadUrl = `https://object.test/renewed-${renewals}`;
      return current;
    },
  });
  expect(renewals).toBe(3);
  expect(await readFile(join(jobRoot, "renewed-job/inputs/dataset/input"), "utf8")).toBe("content");
});

test.each([
  "denied",
  "expired",
  "cancelled",
] as const)("removes a downloaded file when post-transfer authority is %s", async (reason) => {
  const { roots, jobRoot } = await fixture();
  let downloaded = false;
  const controller = new AbortController();
  const executor = new DataDeliveryExecutor({
    roots,
    now: () => 1000,
    fetchImpl: (async () => {
      downloaded = true;
      if (reason === "cancelled") controller.abort(new Error("cancelled"));
      return new Response("content");
    }) as unknown as typeof fetch,
  });
  const original = binding({
    method: DataDeliveryMethod.OBJECT_DOWNLOAD,
    entries: [{ path: "input", value: "content", url: "https://object.test/input" }],
  });
  await expect(
    executor.prepare("denied-job", [original], {
      signal: controller.signal,
      renew: async (previous) => {
        if (!downloaded) return previous;
        if (reason === "denied") throw new Error("authorization denied");
        return create(DataDeliveryBindingSchema, { ...previous, leaseExpiresAtUnixMs: 999n });
      },
    }),
  ).rejects.toThrow();
  expect(downloaded).toBe(true);
  await expect(readFile(join(jobRoot, "denied-job/inputs/dataset/input"))).rejects.toThrow();
});

test("rejects changed data identity before any download", async () => {
  const { roots } = await fixture();
  let downloaded = false;
  const executor = new DataDeliveryExecutor({
    roots,
    fetchImpl: (async () => {
      downloaded = true;
      return new Response("content");
    }) as unknown as typeof fetch,
  });
  const original = binding({
    method: DataDeliveryMethod.OBJECT_DOWNLOAD,
    entries: [{ path: "input", value: "content", url: "https://object.test/input" }],
  });
  await expect(
    executor.prepare("changed-job", [original], {
      renew: async (previous) =>
        create(DataDeliveryBindingSchema, { ...previous, versionId: "replacement" }),
    }),
  ).rejects.toThrow("immutable intent");
  expect(downloaded).toBe(false);
});

test.each([
  "renewed",
  "offline",
  "denied",
  "cancelled",
] as const)("slow Data Market transfer observes continuing authority: %s", async (mode) => {
  const { roots, jobRoot } = await fixture();
  const parent = new AbortController();
  let renewals = 0;
  const authorization = new ExecutionAuthorization(
    Date.now() + 400,
    async (signal) => {
      renewals++;
      if (mode === "offline") await delay(10_000, undefined, { signal });
      if (mode === "denied") throw new Error("permission withdrawn");
      return Date.now() + 400;
    },
    parent.signal,
  );
  let producing: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("a"));
            if (mode === "cancelled") parent.abort(new Error("cancelled"));
            producing = setTimeout(() => {
              controller.enqueue(Buffer.from("b"));
              controller.close();
            }, 900);
          },
          cancel() {
            clearTimeout(producing);
          },
        }),
      ),
  });
  const executor = new DataDeliveryExecutor({ roots });
  const original = binding({
    method: DataDeliveryMethod.OBJECT_DOWNLOAD,
    entries: [{ path: "input", value: "ab", url: `http://127.0.0.1:${server.port}/data` }],
  });
  try {
    const preparing = executor.prepare("slow", [original], { signal: authorization.signal });
    if (mode === "renewed") {
      await preparing;
      expect(renewals).toBeGreaterThan(1);
      expect(await readFile(join(jobRoot, "slow/inputs/dataset/input"), "utf8")).toBe("ab");
    } else {
      await expect(preparing).rejects.toThrow();
      expect(await readdir(join(jobRoot, "slow/inputs/dataset"))).toEqual([]);
    }
  } finally {
    clearTimeout(producing);
    await authorization.close();
    server.stop(true);
  }
});

test("cancelled local verification cannot publish a copied file", async () => {
  const { roots, jobRoot, datasetRoot } = await fixture();
  await writeFile(join(datasetRoot, "managed/input"), "content");
  const controller = new AbortController();
  const executor = new DataDeliveryExecutor({ roots });
  await expect(
    executor.prepare(
      "cancelled-copy",
      [
        binding({
          method: DataDeliveryMethod.STAGE_COPY,
          entries: [{ path: "input", value: "content" }],
        }),
      ],
      {
        signal: controller.signal,
        beforeSideEffect: async () => {
          controller.abort(new Error("permission withdrawn"));
        },
      },
    ),
  ).rejects.toThrow("permission withdrawn");
  expect(await Bun.file(join(jobRoot, "cancelled-copy/inputs/dataset/input")).exists()).toBe(false);
});

test("failed preparation retains cleanup until unmount actually succeeds", async () => {
  const { roots, jobRoot, datasetRoot } = await fixture();
  await writeFile(join(datasetRoot, "managed/input"), "content");
  let unmounts = 0;
  const executor = new DataDeliveryExecutor({
    roots,
    readonlyMountDriver: {
      trusted: true,
      mountReadonly: async () => {
        throw new Error("Mount outcome uncertain");
      },
      unmount: async () => {
        if (++unmounts < 3) throw new Error("Mount still busy");
      },
    },
  });
  await expect(
    executor.prepare("retry-cleanup", [
      binding({
        method: DataDeliveryMethod.READONLY_MOUNT,
        entries: [{ path: "input", value: "content" }],
      }),
    ]),
  ).rejects.toThrow("preparation and cleanup failed");
  await expect(executor.release("retry-cleanup")).rejects.toThrow("cleanup failed");
  expect(await Bun.file(join(jobRoot, "retry-cleanup/inputs/dataset/input")).exists()).toBe(true);
  await executor.release("retry-cleanup");
  expect(unmounts).toBe(3);
  expect(await Bun.file(join(jobRoot, "retry-cleanup/inputs/dataset/input")).exists()).toBe(false);
  await executor.release("retry-cleanup");
  expect(unmounts).toBe(3);
});

test.each([
  0, 1, 32,
])("failed umount is accepted only after mountpoint confirms absence (%i)", async (exitCode) => {
  const commands: string[][] = [];
  const driver = new LinuxBindReadonlyMountDriver({
    run: async (command) => {
      commands.push([...command]);
      return { exitCode: command[0] === "umount" ? 1 : exitCode, stdout: "", stderr: "busy" };
    },
  });
  const releasing = driver.unmount("/managed/input");
  if (exitCode === 32) await releasing;
  else await expect(releasing).rejects.toThrow("bind unmount failed");
  expect(commands).toEqual([
    ["umount", "/managed/input"],
    ["mountpoint", "-q", "--", "/managed/input"],
  ]);
});

test.each([
  "valid",
  "hash",
  "size",
] as const)("NetDrive materialization verifies %s and cleans root and nested inputs", async (mode) => {
  const { roots, jobRoot } = await fixture();
  const executor = new DataDeliveryExecutor({
    roots,
    fetchImpl: (async () => new Response("data")) as unknown as typeof fetch,
  });
  const bindings = netdriveDeliveries(
    ["input.txt", "nested/input.txt"].map((stagePath, index) =>
      create(InputStagingSchema, {
        fileMetadataId: crypto.randomUUID(),
        netdriveInput: true,
        stagePath,
        expectedSha256: mode === "hash" && index === 1 ? "f".repeat(64) : digest("data"),
        expectedSizeBytes: mode === "size" && index === 1 ? 5n : 4n,
        sourceUrl: "https://objects.test/input",
        deliveryLeaseId: crypto.randomUUID(),
        deliveryLeaseExpiresAtUnixMs: BigInt(Date.now() + 60_000),
      }),
    ),
  );
  if (mode === "valid") {
    await executor.prepare("netdrive-job", bindings);
    expect(await readFile(join(jobRoot, "netdrive-job/input.txt"), "utf8")).toBe("data");
    expect(await readFile(join(jobRoot, "netdrive-job/nested/input.txt"), "utf8")).toBe("data");
    await executor.release("netdrive-job");
  } else await expect(executor.prepare("netdrive-job", bindings)).rejects.toThrow();
  await expect(readFile(join(jobRoot, "netdrive-job/input.txt"))).rejects.toThrow();
  await expect(readFile(join(jobRoot, "netdrive-job/nested/input.txt"))).rejects.toThrow();
});
