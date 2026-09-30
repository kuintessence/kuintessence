import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { LicensePolicySchema, SoftwareAssetPayloadSchema, usecase } from "@kuintessence/shared";
import { z } from "zod";
import {
  canonicalJson,
  type SignedEcosystemBundle,
} from "../../../packages/registry/src/services/ecosystem-release-service";
import { jsonRequest, login, ReleaseSchema } from "../spack-case/api";
import { selectedCase } from "../spack-case/fixture";
import {
  managedWorkflowPackage,
  type WorkflowAssets,
  WorkflowAssetsSchema,
} from "./workflow-contract";
import {
  assertWorkflowTestMode,
  workflowPrivateKeyPath,
  workflowSigningKeyId,
  workflowTrustedKeysPath,
} from "./workflow-signing";

export { setupWorkflowSigning } from "./workflow-signing";

export type WorkflowAssetsStage =
  | "guard"
  | "material"
  | "sign"
  | "auth"
  | "import"
  | "activate"
  | "readback"
  | "usecase"
  | "receipt";

export interface WorkflowAssetsOptions {
  onStage?: (stage: WorkflowAssetsStage) => void;
  readText?: (path: string) => Promise<string>;
  readSigner?: () => Promise<KeyObject>;
  login?: typeof login;
  request?: typeof jsonRequest;
  writeReceipt?: (receipt: WorkflowAssets) => Promise<void>;
}

const registryOrigin = "http://registry:3100";
const serverOrigin = "http://server:3000";
const receiptPath = "/case-control/workflow-assets.json";
const ReleaseIdentitySchema = z.object({
  id: z.string().uuid(),
  releaseKey: z.string(),
  version: z.string(),
  artifactDigest: z.string(),
  status: z.string(),
});
const ReleaseStatusSchema = z.object({
  release: ReleaseIdentitySchema,
  assets: z.array(
    z.object({
      ecosystemKey: z.string(),
      kind: z.literal("spack-package"),
      name: z.string(),
      version: z.string(),
      assetId: z.string().uuid(),
      assetRevisionId: z.string().uuid(),
      payload: SoftwareAssetPayloadSchema,
      licensePolicy: LicensePolicySchema,
    }),
  ),
});
const PackageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  namespace: z.literal("platform"),
  spec: usecase.GovernedUsecasePackageSchema,
  publishedSoftwareRevisionId: z.string().uuid().optional(),
});

async function readSigner() {
  const file = await open(workflowPrivateKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() &&
        stat.uid === 0 &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size > 0 &&
        stat.size <= 8192,
      "Workflow signer must be a bounded root-owned mode-0600 regular file",
    );
    const key = createPrivateKey(await file.readFile());
    assert.equal(key.asymmetricKeyType, "ed25519", "Workflow signer must be Ed25519");
    const publicSpki = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
    const trusted = z.record(z.string(), z.string()).parse(
      JSON.parse(await readFile(workflowTrustedKeysPath, "utf8")),
    );
    assert.equal(trusted[workflowSigningKeyId], publicSpki, "Workflow signer trust mismatch");
    return key;
  } finally {
    await file.close();
  }
}

async function writeReceipt(receipt: WorkflowAssets): Promise<void> {
  const file = await open(receiptPath, "wx", 0o444);
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`);
    await file.chmod(0o444);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Operator-only HTTP registration; never imports a service instance or writes database rows. */
export async function registerWorkflowAssets(
  options: WorkflowAssetsOptions = {},
): Promise<WorkflowAssets> {
  const progress = (stage: WorkflowAssetsStage) => options.onStage?.(stage);
  progress("guard");
  assertWorkflowTestMode();
  const fixture = selectedCase();
  progress("material");
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const release = ReleaseSchema.parse(JSON.parse(await readText("/case-control/release.json")));
  assert.equal(release.spec, fixture.spec, "Workflow material spec does not match selected case");
  assert.equal(
    release.binding.repositoryId,
    createHash("sha256").update(fixture.repository).digest("hex"),
    "Workflow material repository does not match selected case",
  );
  assert.equal(
    release.recipeId,
    createHash("sha256").update(fixture.recipes).digest("hex"),
    "Workflow recipe repository does not match selected case",
  );
  const spec = managedWorkflowPackage();
  assert.deepEqual(
    spec.softwareRef,
    { source: "platform-fork", name: fixture.name, version: fixture.version },
    "Workflow package must reference the activated platform-fork software",
  );
  progress("sign");
  const privateKey = await (options.readSigner ?? readSigner)();
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Workflow signer must be Ed25519");
  const releaseKey = `pr-spack-managed-${fixture.id}-workflow`;
  const ecosystemKey = `spack:${fixture.name}@${fixture.version}`;
  const payload = SoftwareAssetPayloadSchema.parse({
    kind: "spack-package",
    spack: { packageName: fixture.name, defaultSpec: fixture.spec },
  });
  const licensePolicy = LicensePolicySchema.parse({
    classification: "open-source",
    identifiers: [{ kind: "spdx", value: fixture.id === "hello" ? "GPL-3.0-or-later" : "MIT" }],
    provenance: {
      source: "platform-fork",
      reference: `${fixture.recipes}@${release.commit}`,
    },
    acceptanceRequired: false,
    providerEntitlements: [],
    consumerEntitlements: [],
    redistribution: "restricted",
    autoInstall: "denied",
  });
  const manifest: SignedEcosystemBundle["manifest"] = {
    schemaVersion: 1,
    releaseKey,
    version: "1",
    provenance: { source: "pr-spack-managed", materialBinding: release.binding },
    assets: [
      {
        ecosystemKey,
        kind: "spack-package",
        name: fixture.name,
        version: fixture.version,
        payload,
        provenance: { source: "platform-fork", recipeCommit: release.commit },
        licensePolicy,
      },
    ],
  };
  // Sign the Registry's exact canonical UTF-8 manifest bytes, not the envelope or a digest.
  const signedBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const bundle: SignedEcosystemBundle = {
    manifest,
    signingKeyId: workflowSigningKeyId,
    signature: sign(null, signedBytes, privateKey).toString("base64"),
  };
  const expectedDigest = `sha256:${createHash("sha256").update(signedBytes).digest("hex")}`;
  progress("auth");
  const token = await (options.login ?? login)(serverOrigin);
  const send = options.request ?? jsonRequest;
  const request = (path: string, body?: unknown) => send(registryOrigin, token, path, body);
  progress("import");
  const imported = ReleaseIdentitySchema.parse(await request("/ecosystem-releases/import", bundle));
  assert.equal(imported.releaseKey, releaseKey, "Workflow release identity mismatch");
  assert.equal(imported.version, manifest.version, "Workflow release version mismatch");
  assert.equal(imported.artifactDigest, expectedDigest, "Workflow release digest mismatch");
  progress("activate");
  const activated = ReleaseIdentitySchema.parse(
    await request(`/ecosystem-releases/${imported.id}/activate`, {}),
  );
  assert.equal(activated.id, imported.id, "Workflow activation identity mismatch");
  assert.equal(activated.status, "active", "Workflow release did not activate");
  progress("readback");
  const status = ReleaseStatusSchema.parse(
    await request(`/ecosystem-releases/${releaseKey}/status`),
  );
  assert.equal(status.release.id, imported.id, "Workflow active release mismatch");
  assert.equal(status.release.status, "active", "Workflow release is not active");
  assert.equal(status.release.artifactDigest, expectedDigest, "Workflow active digest mismatch");
  assert.equal(status.assets.length, 1, "Workflow release must contain exactly one software asset");
  const asset = status.assets[0];
  assert(asset, "Workflow software asset is missing");
  assert.equal(asset.ecosystemKey, ecosystemKey, "Workflow ecosystem key mismatch");
  assert.equal(asset.name, fixture.name, "Workflow software name mismatch");
  assert.equal(asset.version, fixture.version, "Workflow software version mismatch");
  assert.deepEqual(asset.payload, payload, "Workflow software payload mismatch");
  assert.deepEqual(asset.licensePolicy, licensePolicy, "Workflow LicensePolicy mismatch");
  progress("usecase");
  const create = usecase.UsecasePackageCreateSchema.parse({
    name: `pr-managed-${fixture.id}-workflow`,
    version: "1",
    spec,
  });
  const created = PackageSchema.parse(await request("/usecase-packages", create));
  assert.equal(created.name, create.name, "Workflow package name mismatch");
  assert.equal(created.version, create.version, "Workflow package version mismatch");
  assert.deepEqual(created.spec, spec, "Workflow package content mismatch");
  const published = PackageSchema.parse(await request(`/usecase-packages/${created.id}`));
  assert.equal(published.id, created.id, "Workflow package identity mismatch");
  assert.deepEqual(published.spec, spec, "Workflow published package content mismatch");
  assert.equal(
    published.publishedSoftwareRevisionId,
    asset.assetRevisionId,
    "Workflow package did not resolve the activated software revision",
  );
  progress("receipt");
  const receipt = WorkflowAssetsSchema.parse({
    usecaseId: created.id,
    softwareRevisionId: asset.assetRevisionId,
  });
  await (options.writeReceipt ?? writeReceipt)(receipt);
  return receipt;
}

if (import.meta.main) {
  let stage: WorkflowAssetsStage = "guard";
  try {
    await registerWorkflowAssets({
      onStage: (next) => {
        stage = next;
      },
    });
    console.log("Spack workflow assets: status=succeeded");
  } catch {
    console.error(`Spack workflow assets: stage=${stage} status=failed`);
    process.exitCode = 1;
  }
}
