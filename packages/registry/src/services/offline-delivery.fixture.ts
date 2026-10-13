import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ecosystemCanonicalJson,
  OfflineDeliverySchema,
  type SpackMaterialPublish,
} from "@kuintessence/shared";
import { RecipeGitStore } from "./recipe-git-store";
import { materialDigest } from "./spack-material-storage";

// Synthetic contract fixture only: never use its lock as native installation evidence.
export async function createOfflineDeliveryFixture(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const source = join(root, "recipe-source");
  await mkdir(source);
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", source, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      })
    ).stdout.trim();
  await git("init", "--template=");
  await git("symbolic-ref", "HEAD", "refs/heads/main");
  await mkdir(join(source, "repo/packages/hello"), { recursive: true });
  await writeFile(join(source, "repo/repo.yaml"), "repo:\n  namespace: builtin\n  api: v2.0\n");
  await writeFile(
    join(source, "repo/packages/hello/package.py"),
    'from spack.package import *\nclass Hello(Package):\n    version("1.0", sha256="' +
      "a".repeat(64) +
      '")\n',
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await git("bundle", "create", join(root, "recipe.bundle"), "HEAD");
  const commit = await git("rev-parse", "HEAD");
  const sourceBytes = Buffer.from("Synthetic source: not an install fixture.\n");
  const sourceBlob = { digest: materialDigest(sourceBytes), size: sourceBytes.length };
  const notice = Buffer.from("Synthetic notice. License review pending.\n");
  const noticeBlob = { digest: materialDigest(notice), size: notice.length };
  const lock = Buffer.from(
    JSON.stringify({
      _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
      spack: { version: "1.0.0", type: "release" },
      roots: [{ spec: "hello@1.0", hash: "a".repeat(32) }],
      concrete_specs: {
        ["a".repeat(32)]: {
          name: "hello",
          version: "1.0",
          namespace: "builtin",
          hash: "a".repeat(32),
          arch: { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" },
          parameters: {},
        },
      },
    }),
  );
  const release: SpackMaterialPublish = {
    version: 2,
    repository: "public/fixture",
    spec: "hello@1.0",
    target: "linux-ubuntu24.04-x86_64",
    spackVersion: "1.0.0",
    redistribution: "unrestricted",
    recipes: [
      { repositoryId: RecipeGitStore.repositoryId("public/fixture"), commit, roots: ["repo"] },
    ],
    sources: [{ path: "hello/source.tar.gz", blob: sourceBlob }],
    lockfile: { digest: materialDigest(lock), size: lock.length },
    evidence: {
      version: 1,
      materials: [
        {
          subject: sourceBlob,
          license: { expression: "LicenseRef-Fixture", status: "pending" },
          provenance: [
            { origin: "synthetic-contract-fixture", original: sourceBlob, evidence: noticeBlob },
          ],
          attachments: [{ path: "NOTICE.txt", kind: "notice", blob: noticeBlob }],
        },
      ],
    },
  };
  const manifest = {
    schemaVersion: 1 as const,
    releaseKey: "offline-contract-fixture",
    version: "1.0.0",
    provenance: { source: "synthetic-contract-fixture" },
    assets: [
      {
        ecosystemKey: "software/hello",
        kind: "spack-package" as const,
        name: "Hello",
        version: "1.0",
        payload: {
          kind: "spack-package",
          spack: {
            packageName: "hello",
            metadata: {},
            defaultSpec: "hello@1.0",
            dependencies: [],
            providers: [],
            variants: [],
          },
        },
        provenance: { source: "synthetic-contract-fixture" },
        licensePolicy: {
          classification: "open-source",
          identifiers: [{ kind: "spdx", value: "MIT" }],
          provenance: {
            source: "official-upstream",
            reference: "https://opensource.org/license/mit",
          },
          acceptanceRequired: false,
          providerEntitlements: [],
          consumerEntitlements: [],
          autoInstall: "allowed",
          redistribution: "permitted",
        },
      },
    ],
  };
  const keys = generateKeyPairSync("ed25519");
  const bundle = {
    manifest,
    signingKeyId: "fixture-only",
    signature: sign(null, Buffer.from(ecosystemCanonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    ),
  };
  const contents = new Map([
    ["recipe.bundle", await readFile(join(root, "recipe.bundle"))],
    ["source.tar.gz", sourceBytes],
    ["spack.lock", lock],
    ["NOTICE.txt", notice],
    ["ecosystem.json", Buffer.from(JSON.stringify(bundle))],
  ]);
  for (const [path, bytes] of contents) await writeFile(join(root, path), bytes, { mode: 0o600 });
  const plan = OfflineDeliverySchema.parse({
    version: 1,
    name: "contract-fixture",
    release: "1",
    repository: "public/fixture",
    files: [...contents].map(([path, bytes]) => ({
      path,
      blob: { digest: materialDigest(bytes), size: bytes.length },
    })),
    items: [
      { id: "recipe", kind: "recipe", repository: "public/fixture", commit, file: "recipe.bundle" },
      { id: "material", kind: "material", dependsOn: ["recipe"], release },
      { id: "ecosystem", kind: "ecosystem", file: "ecosystem.json" },
    ],
  });
  await writeFile(join(root, "delivery.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
  const trustedKeys = {
    "fixture-only": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  await writeFile(join(root, "trusted-keys.json"), JSON.stringify(trustedKeys), { mode: 0o600 });
  return { plan, contents, trustedKeys, bundle };
}
