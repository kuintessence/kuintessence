import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpackMaterialManifest } from "@kuintessence/shared";
import type { SpackAuditRuntimeProfile } from "./audit-runtime";
import type { SpackInstallReport, SpackInstallSiteProfile } from "./install-contract";
import type { VerifiedSpackInstallSite } from "./install-runner";
import { SpackMaterialClient } from "./material-client";

export const installRootHash = "a".repeat(32);
export const installDigest = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const blob = (text: string) => ({ digest: installDigest(text), size: Buffer.byteLength(text) });
export const installRuntime: SpackAuditRuntimeProfile = {
  apptainerPath: "/usr/bin/apptainer",
  apptainerSha256: "a".repeat(64),
  sifPath: "/srv/kq/runtime.sif",
  sifSha256: "b".repeat(64),
};

export async function makeInstallFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kq-install-")));
  const cacheDir = join(root, "cache");
  const lock = JSON.stringify({
    _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
    spack: { version: "1.0.0", type: "release" },
    roots: [{ spec: "hello@1.0", hash: installRootHash }],
    concrete_specs: {
      [installRootHash]: {
        name: "hello",
        version: "1.0",
        namespace: "builtin",
        hash: installRootHash,
        arch: { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" },
        parameters: {},
      },
    },
  });
  const recipe = "opaque recipe; fixture never executes Python";
  const source = "opaque source; fixture never runs Spack";
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository: "public/test",
    spec: "hello@1.0",
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    recipes: [
      {
        repositoryId: "b".repeat(64),
        commit: "c".repeat(40),
        roots: ["."],
        archive: blob(recipe),
      },
    ],
    sources: [{ path: "hello/hello-1.0.tar.gz", blob: blob(source) }],
    lockfile: blob(lock),
  };
  const text = JSON.stringify(manifest);
  const input = {
    operationId: "fixture-install",
    ticket: "private-fixture-ticket",
    manifestDigest: installDigest(text),
    spec: manifest.spec,
    spackVersion: manifest.spackVersion,
  };
  const values = new Map([recipe, source, lock].map((value) => [installDigest(value), value]));
  const client = new SpackMaterialClient({
    cacheDir,
    serverUrl: "https://server.example",
    fetch: async (url) =>
      new Response(url.endsWith("/manifest") ? text : values.get(url.split("/").at(-1) ?? "")),
  });
  const prepared = await client.prepare(input);
  const profile: SpackInstallSiteProfile = {
    version: 1,
    storeRoot: join(root, "site", "store"),
    target: manifest.target,
    runtimeSifSha256: installRuntime.sifSha256,
    osReleaseSha256: "c".repeat(64),
    hostFiles: [{ path: "/usr/bin/true", sha256: "d".repeat(64) }],
    externals: [],
    sharedStoreConfirmed: true,
    compatibleComputeNodesConfirmed: true,
    trustedRecipesConfirmed: true,
    quotaEnforcedBySite: true,
  };
  const profileText = JSON.stringify(profile);
  const site: VerifiedSpackInstallSite = {
    profile,
    digest: installDigest(profileText),
    bytes: new TextEncoder().encode(profileText),
  };
  const siteOptions = {
    path: "/etc/kq/site.json",
    sha256: site.digest.slice(7),
    runtime: installRuntime,
  };
  function report(action: SpackInstallReport["action"], storePath: string): SpackInstallReport {
    return {
      version: 1,
      validation: "isolated-install",
      action,
      manifestDigest: input.manifestDigest,
      siteProfileDigest: site.digest,
      storePath,
      root: {
        name: "hello",
        version: "1.0",
        hash: installRootHash,
        spec: input.spec,
        arch: manifest.target,
      },
      prefix: join(storePath, "hello"),
      installedHashes: [installRootHash],
      ...(action === "load"
        ? { loadShell: `export PATH='${storePath}/hello/bin':"$PATH";\n` }
        : {}),
    };
  }
  return {
    root,
    cacheDir,
    client,
    prepared,
    input,
    site,
    siteOptions,
    report,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
