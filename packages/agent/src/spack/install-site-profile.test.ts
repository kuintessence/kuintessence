import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpackAuditRuntimeProfile } from "./audit-runtime";
import type { SpackInstallSiteProfile } from "./install-contract";
import {
  loadSpackInstallSiteProfile,
  type SpackInstallSiteProfileOptions,
} from "./install-site-profile";

const PROFILE_MAXIMUM = 128 * 1024;
const HOST_MAXIMUM = 16 * 1024 ** 3;
const FAILURE = "Spack install site profile verification failed";
const ABORTED = "Spack install site profile load aborted";
const profilePath = "/etc/kuintessence/site.json";
const runtime: SpackAuditRuntimeProfile = {
  apptainerPath: "/usr/bin/apptainer",
  apptainerSha256: "a".repeat(64),
  sifPath: "/srv/kq/runtime.sif",
  sifSha256: "b".repeat(64),
};
const profile: SpackInstallSiteProfile = {
  version: 1,
  storeRoot: "/srv/kq/store",
  target: "linux-ubuntu22.04-x86_64",
  runtimeSifSha256: runtime.sifSha256,
  osReleaseSha256: "c".repeat(64),
  hostFiles: [
    { path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
    { path: "/usr/bin/cc", sha256: "e".repeat(64) },
  ],
  externals: [],
  sharedStoreConfirmed: true,
  compatibleComputeNodesConfirmed: true,
  trustedRecipesConfirmed: true,
  quotaEnforcedBySite: true,
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type Inspect = NonNullable<SpackInstallSiteProfileOptions["inspect"]>;

function fixture(value: unknown = profile, bytes = encode(value)) {
  const calls: { path: string; maximum: number; collect: boolean; signal: AbortSignal }[] = [];
  const inspect: Inspect = async (path, maximum, collect, signal) => {
    calls.push({ path, maximum, collect, signal });
    if (path === profilePath) return { sha256: sha256(bytes), bytes };
    if (path === "/etc/os-release") return { sha256: profile.osReleaseSha256 };
    const pin = profile.hostFiles.find((file) => file.path === path);
    if (!pin) throw new Error(`Unexpected fixture read: ${path}`);
    return { sha256: pin.sha256 };
  };
  return { options: { path: profilePath, sha256: sha256(bytes), runtime, inspect }, calls, bytes };
}

describe("trusted Spack install site profiles", () => {
  test("returns exact bytes and a material digest after checking every pin", async () => {
    const bytes = new TextEncoder().encode(` \n${JSON.stringify(profile, null, 2)}\n`);
    const f = fixture(profile, bytes);
    const signal = new AbortController().signal;
    const loaded = await loadSpackInstallSiteProfile(f.options, signal);
    expect(loaded).toEqual({ profile, bytes, digest: `sha256:${sha256(bytes)}` });
    expect(f.calls).toEqual([
      { path: profilePath, maximum: PROFILE_MAXIMUM, collect: true, signal },
      { path: "/etc/os-release", maximum: HOST_MAXIMUM, collect: false, signal },
      ...profile.hostFiles.map(({ path }) => ({
        path,
        maximum: HOST_MAXIMUM,
        collect: false,
        signal,
      })),
    ]);
  });

  test.each([
    "relative",
    "/",
    "/etc/../site.json",
    "/etc/./site.json",
    "/etc//site.json",
    "/etc/site.json/",
    "/etc/site.json\0",
    "/etc/site.json\n",
    "/etc/token:secret",
    "/etc/a,b",
    "/etc/a\\b",
    `/etc/${"a".repeat(1024)}`,
  ])("rejects unsafe profile paths before inspecting: %j", async (path) => {
    const f = fixture();
    await expect(
      loadSpackInstallSiteProfile({ ...f.options, path }, new AbortController().signal),
    ).rejects.toThrow(FAILURE);
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    "",
    "a".repeat(63),
    "A".repeat(64),
    `sha256:${"a".repeat(64)}`,
    "g".repeat(64),
  ])("rejects invalid configured digests before inspecting: %j", async (digest) => {
    const f = fixture();
    await expect(
      loadSpackInstallSiteProfile({ ...f.options, sha256: digest }, new AbortController().signal),
    ).rejects.toThrow(FAILURE);
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    { sifPath: "/srv/kq/../runtime.sif" },
    { apptainerPath: "/usr/bin/apptainer:secret" },
    { sifSha256: "invalid" },
    { apptainerSha256: "invalid" },
    { sifPath: runtime.apptainerPath },
  ])("rejects unsafe runtime configuration: %j", async (changed) => {
    const f = fixture();
    await expect(
      loadSpackInstallSiteProfile(
        { ...f.options, runtime: { ...runtime, ...changed } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(FAILURE);
    expect(f.calls).toHaveLength(0);
  });

  test("checks both the inspector digest and the exact collected bytes", async () => {
    for (const [configured, inspected, bytes] of [
      ["f".repeat(64), "f".repeat(64), encode(profile)],
      [sha256(encode(profile)), "f".repeat(64), encode(profile)],
      [sha256(encode(profile)), sha256(encode(profile)), undefined],
    ] as const) {
      const f = fixture();
      await expect(
        loadSpackInstallSiteProfile(
          {
            ...f.options,
            sha256: configured,
            inspect: async () => ({ sha256: inspected, bytes }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(FAILURE);
    }
  });

  test("snapshots collected bytes before an inspector can mutate its backing buffer", async () => {
    const f = fixture();
    const original = Uint8Array.from(f.bytes);
    const inspect: Inspect = async (...args) => {
      const result = await f.options.inspect(...args);
      if (!args[2]) f.bytes.fill(0);
      return result;
    };
    const loaded = await loadSpackInstallSiteProfile(
      { ...f.options, inspect },
      new AbortController().signal,
    );
    expect(loaded.bytes).toEqual(original);
    expect(loaded.digest).toBe(`sha256:${sha256(original)}`);
    expect(loaded.profile).toEqual(profile);
  });

  test("accepts exactly 128 KiB and rejects an oversized collected profile", async () => {
    const text = JSON.stringify(profile);
    for (const length of [PROFILE_MAXIMUM, PROFILE_MAXIMUM + 1]) {
      const bytes = new TextEncoder().encode(text.padEnd(length, " "));
      const f = fixture(profile, bytes);
      const loaded = loadSpackInstallSiteProfile(f.options, new AbortController().signal);
      if (length === PROFILE_MAXIMUM) {
        expect((await loaded).bytes).toEqual(bytes);
      } else {
        await expect(loaded).rejects.toThrow(FAILURE);
        expect(f.calls).toHaveLength(1);
      }
    }
  });

  test.each([
    { version: 2 },
    { target: "secret credentials" },
    { storeRoot: "/etc/store" },
    { hostFiles: [] },
    { hostFiles: [...profile.hostFiles, profile.hostFiles[0]] },
    { hostFiles: [{ path: "/usr/lib/../secret", sha256: "d".repeat(64) }] },
    { hostFiles: [{ path: "/usr/lib/libc.so.6", sha256: "invalid" }] },
    {
      hostFiles: Array.from({ length: 257 }, (_, index) => ({
        path: `/usr/lib/pin-${index}`,
        sha256: "d".repeat(64),
      })),
    },
    { externals: [{ hash: "invalid", prefix: "/usr/lib" }] },
    {
      externals: [
        { hash: "a".repeat(32), prefix: "/opt/site/first" },
        { hash: "a".repeat(32), prefix: "/opt/site/second" },
      ],
    },
    { trustedRecipesConfirmed: false },
    { sharedStoreConfirmed: false },
    { compatibleComputeNodesConfirmed: false },
    { quotaEnforcedBySite: false },
    { unknownSecret: "credentials" },
    { runtimeSifSha256: "f".repeat(64) },
  ])("rejects invalid schemas and mismatched runtime bindings: %j", async (changed) => {
    const f = fixture({ ...profile, ...changed });
    await expect(
      loadSpackInstallSiteProfile(f.options, new AbortController().signal),
    ).rejects.toThrow(FAILURE);
    expect(f.calls).toHaveLength(1);
  });

  test.each([
    new TextEncoder().encode("{malformed-secret"),
    new Uint8Array([0xff, ...encode(profile)]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...encode(profile)]),
    encode(null),
    encode([]),
  ])("rejects malformed JSON, invalid UTF-8 and BOM", async (bytes) => {
    const f = fixture(profile, bytes);
    await expect(
      loadSpackInstallSiteProfile(f.options, new AbortController().signal),
    ).rejects.toThrow(FAILURE);
    expect(f.calls).toHaveLength(1);
  });

  test.each([
    "/etc/os-release",
    ...profile.hostFiles.map((file) => file.path),
  ])("rejects a mismatched or unreadable host pin: %s", async (target) => {
    for (const failsRead of [false, true]) {
      const f = fixture();
      const inspect: Inspect = async (...args) => {
        if (args[0] === target) {
          if (failsRead) throw new Error("token=secret /private/path");
          return { sha256: "f".repeat(64) };
        }
        return f.options.inspect(...args);
      };
      await expect(
        loadSpackInstallSiteProfile({ ...f.options, inspect }, new AbortController().signal),
      ).rejects.toThrow(FAILURE);
    }
  });

  for (const kind of ["host", "sif", "apptainer", "profile"] as const) {
    test.each([
      "/srv/kq/store",
      "/srv/kq/store/pin",
      "/srv/kq",
    ])(`rejects ${kind} overlap in either ancestor direction: %s`, async (path) => {
      const changed =
        kind === "host" ? { ...profile, hostFiles: [{ path, sha256: "d".repeat(64) }] } : profile;
      const f = fixture(changed);
      const options: SpackInstallSiteProfileOptions = {
        ...f.options,
        ...(kind === "profile" ? { path } : {}),
        runtime: {
          ...runtime,
          ...(kind === "sif" ? { sifPath: path } : {}),
          ...(kind === "apptainer" ? { apptainerPath: path } : {}),
        },
        inspect: async (...args) => {
          if (args[2]) return { sha256: sha256(f.bytes), bytes: f.bytes };
          return f.options.inspect(...args);
        },
      };
      await expect(
        loadSpackInstallSiteProfile(options, new AbortController().signal),
      ).rejects.toThrow(FAILURE);
      expect(f.calls).toHaveLength(0);
    });
  }

  test("does not confuse sibling names with ancestors", async () => {
    const changed = {
      ...profile,
      hostFiles: [{ path: "/srv/kq/store-backup/pin", sha256: "d".repeat(64) }],
    };
    const f = fixture(changed);
    const inspect: Inspect = async (...args) =>
      args[0] === changed.hostFiles[0]?.path
        ? { sha256: "d".repeat(64) }
        : f.options.inspect(...args);
    const loaded = await loadSpackInstallSiteProfile(
      { ...f.options, inspect },
      new AbortController().signal,
    );
    expect(loaded.profile).toEqual(changed);
  });

  test("redacts inspector errors including their causes", async () => {
    const f = fixture();
    const secret = "https://user:password@host.invalid/private";
    const error = await loadSpackInstallSiteProfile(
      {
        ...f.options,
        inspect: async () => {
          throw new Error(secret, { cause: new Error(secret) });
        },
      },
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected an error");
    expect(error.message).toBe(FAILURE);
    expect(error.cause).toBeUndefined();
    expect(error.stack).not.toContain(secret);
  });

  test("redacts synchronous inspector errors", async () => {
    const f = fixture();
    const inspect: Inspect = () => {
      throw new Error("token=secret /private/path");
    };
    await expect(
      loadSpackInstallSiteProfile({ ...f.options, inspect }, new AbortController().signal),
    ).rejects.toThrow(FAILURE);
  });

  test("rejects an already aborted signal before any inspection", async () => {
    const f = fixture();
    await expect(
      loadSpackInstallSiteProfile(f.options, AbortSignal.abort(new Error("secret"))),
    ).rejects.toThrow(ABORTED);
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    profilePath,
    "/etc/os-release",
    ...profile.hostFiles.map((file) => file.path),
  ])("honors cancellation during inspection of %s", async (target) => {
    const controller = new AbortController();
    const f = fixture();
    const inspect: Inspect = async (...args) => {
      const result = await f.options.inspect(...args);
      if (args[0] === target) controller.abort("credentials");
      return result;
    };
    const error = await loadSpackInstallSiteProfile(
      { ...f.options, inspect },
      controller.signal,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected an error");
    expect(error.message).toBe(ABORTED);
    expect(error.name).toBe("AbortError");
    expect(f.calls.at(-1)?.path).toBe(target);
  });

  test("cancels an inspector that does not settle", async () => {
    const controller = new AbortController();
    const f = fixture();
    const inspect: Inspect = () => {
      queueMicrotask(() => controller.abort("secret"));
      return new Promise(() => {});
    };
    await expect(
      loadSpackInstallSiteProfile({ ...f.options, inspect }, controller.signal),
    ).rejects.toThrow(ABORTED);
  });

  test.skipIf(process.getuid?.() === 0)(
    "default inspector rejects user-owned files, links and directories without privilege",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "kq-site-profile-"));
      try {
        const bytes = encode(profile);
        const regular = join(directory, "profile.json");
        const writable = join(directory, "writable.json");
        const link = join(directory, "linked.json");
        const broken = join(directory, "broken.json");
        const nested = join(directory, "not-a-file");
        await writeFile(regular, bytes, { mode: 0o400 });
        await writeFile(writable, bytes, { mode: 0o666 });
        await symlink(regular, link);
        await symlink(join(directory, "missing.json"), broken);
        await mkdir(nested);
        for (const path of [regular, writable, link, broken, nested]) {
          await expect(
            loadSpackInstallSiteProfile(
              { path, sha256: sha256(bytes), runtime },
              new AbortController().signal,
            ),
          ).rejects.toThrow(FAILURE);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
