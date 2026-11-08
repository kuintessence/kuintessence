import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { ecosystemReleaseAssets, type PgDb } from "@kuintessence/db";
import {
  ecosystemCanonicalJson,
  SoftwareAssetPayloadSchema,
  workflowDsl,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import {
  EcosystemReleaseService,
  type SignedEcosystemBundle,
} from "../../packages/registry/src/services/ecosystem-release-service";
import { federationMaterialDigest } from "../../packages/server/src/federation/assets";

export async function importMediaScript(
  db: PgDb,
  root: string,
  actor: string,
  bundle: SignedEcosystemBundle,
) {
  const trust = JSON.parse(process.env.ECOSYSTEM_RELEASE_TRUSTED_KEYS ?? "{}");
  const releases = new EcosystemReleaseService(db, trust);
  const staged = await releases.stage(bundle, actor);
  await releases.activate(staged.id, actor);
  const [entry] = await db
    .select()
    .from(ecosystemReleaseAssets)
    .where(
      and(
        eq(ecosystemReleaseAssets.releaseId, staged.id),
        eq(ecosystemReleaseAssets.ecosystemKey, "script/media-reader"),
      ),
    );
  assert(
    entry?.assetId && entry.assetRevisionId,
    "Signed script must be activated by the real importer",
  );
  await Bun.write(
    `${root}/media-script-release.json`,
    JSON.stringify({
      releaseId: staged.id,
      assetId: entry.assetId,
      revisionId: entry.assetRevisionId,
    }),
  );
  return { assetId: entry.assetId, assetRevisionId: entry.assetRevisionId };
}

export async function mediaExecutionFixture(
  db: PgDb,
  root: string,
  actor: string,
  sourceSiteId: string,
) {
  const content = `set -euo pipefail
[[ $(/usr/bin/cat /kq/inputs/dataset/input.dat) == data ]]
if (printf changed > /kq/inputs/dataset/input.dat) 2>/dev/null; then exit 31; fi
status=$(/usr/bin/cat /proc/self/status)
[[ $status == *$'Seccomp:\\t2'* && $status == *$'NoNewPrivs:\\t1'* ]]
socket_error=$({ : >/dev/tcp/127.0.0.1/9; } 2>&1) && exit 32
[[ $socket_error == *'Operation not permitted'* ]]
/bin/sleep 300
`;
  const script = SoftwareAssetPayloadSchema.parse({
    kind: "sandbox-script",
    language: "bash",
    entrypoint: "main.sh",
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    runtimeContractRef: { name: "bash", version: "1" },
    inputs: { dataset: { type: "FileBatch", required: true } },
    outputs: {},
  });
  assert(script.kind === "sandbox-script");
  const manifest = {
    schemaVersion: 1 as const,
    releaseKey: "media-execution-lab",
    version: "1.0.0",
    provenance: { source: "isolated acceptance fixture" },
    assets: [
      {
        ecosystemKey: "script/media-reader",
        kind: "sandbox-script" as const,
        name: "Read imported observations",
        version: "1.0.0",
        payload: script,
        provenance: { source: "isolated acceptance fixture" },
        licensePolicy: {
          classification: "open-source",
          identifiers: [{ kind: "spdx", value: "CC0-1.0" }],
          provenance: {
            source: "official-upstream",
            reference: "https://creativecommons.org/publicdomain/zero/1.0/",
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
  const bundle: SignedEcosystemBundle = {
    manifest,
    signingKeyId: "lab-sandbox",
    signature: sign(
      null,
      Buffer.from(ecosystemCanonicalJson(manifest)),
      createPrivateKey(await Bun.file(`${root}/sandbox.key`).text()),
    ).toString("base64"),
  };
  const entry = await importMediaScript(db, root, actor, bundle);
  const scriptReference = {
    originSiteId: sourceSiteId,
    kind: "script" as const,
    id: entry.assetId,
    revision: "1",
    digest: federationMaterialDigest(script),
  };
  const dataset = {
    assetId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    locationId: crypto.randomUUID(),
    sha256: createHash("sha256").update("data").digest("hex"),
    metadata: {
      license: "CC0-1.0",
      provenance: { source: "synthetic acceptance input", generator: "KQ media lab" },
    },
  };
  const reference = {
    originSiteId: sourceSiteId,
    kind: "dataset" as const,
    id: dataset.assetId,
    revision: "v1",
    digest: federationMaterialDigest({
      files: [{ path: "input.dat", sizeBytes: 4, sha256: dataset.sha256, ...dataset.metadata }],
    }),
  };
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Use imported observations",
    spec: {
      nodeDrafts: [
        {
          id: "reader",
          name: "Read observations",
          type: "Script",
          source: {
            type: "AssetRevision",
            assetId: scriptReference.id,
            assetRevisionId: entry.assetRevisionId,
            revision: 1,
            sha256: script.sha256,
          },
          runtimeContractRef: { name: "bash", version: "1" },
          inputs: { dataset: { type: "FileBatch" } },
          outputs: {},
          inputSlots: [
            {
              type: "Dataset",
              descriptor: "dataset",
              contents: {
                source: "data-market",
                assetId: dataset.assetId,
                versionId: dataset.versionId,
                manifestDigest: reference.digest,
                selectedEntries: ["input.dat"],
                targetPath: "inputs/dataset",
              },
            },
          ],
        },
      ],
      nodeRelations: [],
    },
  });
  return {
    workflow,
    dataset: { ...dataset, reference },
    bundle,
    scriptReference,
    scriptRevisionId: entry.assetRevisionId,
    inputs: {
      protocolVersion: 1 as const,
      kind: "inputs" as const,
      parameters: {},
      datasets: [
        {
          descriptor: "dataset",
          asset: reference,
          selectedEntries: ["input.dat"],
          targetPath: "inputs/dataset",
        },
      ],
      bindings: [{ sourceRevisionId: entry.assetRevisionId, asset: scriptReference }],
    },
  };
}
