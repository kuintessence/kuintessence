import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { usecase } from "@kuintessence/shared";
import { z } from "zod";
import { jsonRequest, login } from "../spack-case/api";
import { selectedCase } from "../spack-case/fixture";
import { FileWorkflowAssetsSchema, fileWorkflowPackage } from "./file-workflow-contract";
import { managedWorkflowPackage, WorkflowAssetsSchema } from "./workflow-contract";
import { assertWorkflowTestMode } from "./workflow-signing";

type FileWorkflowAssets = z.infer<typeof FileWorkflowAssetsSchema>;

export type FileWorkflowAssetsStage =
  | "guard"
  | "material"
  | "auth"
  | "readback"
  | "usecase"
  | "receipt";

export interface FileWorkflowAssetsOptions {
  onStage?: (stage: FileWorkflowAssetsStage) => void;
  readText?: (path: string) => Promise<string>;
  login?: typeof login;
  request?: typeof jsonRequest;
  writeReceipt?: (receipt: FileWorkflowAssets) => Promise<void>;
}

const registryOrigin = "http://registry:3100";
const serverOrigin = "http://server:3000";
const receiptPath = "/case-control/file-workflow-assets.json";
const PackageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  namespace: z.literal("platform"),
  spec: usecase.GovernedUsecasePackageSchema,
  publishedSoftwareRevisionId: z.string().uuid().optional(),
});

async function writeReceipt(receipt: FileWorkflowAssets): Promise<void> {
  const file = await open(receiptPath, "wx", 0o444);
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`);
    await file.chmod(0o444);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Reuse the signed software registration; only publish governed usecases over HTTP. */
export async function registerFileWorkflowAssets(
  options: FileWorkflowAssetsOptions = {},
): Promise<FileWorkflowAssets> {
  const progress = (stage: FileWorkflowAssetsStage) => options.onStage?.(stage);
  progress("guard");
  assertWorkflowTestMode();
  assert.equal(
    process.env.KQ_PR_SPACK_FILE_WORKFLOW,
    "1",
    "File workflow acceptance is not enabled",
  );
  const fixture = selectedCase();
  assert.equal(fixture.id, "samtools", "File workflow acceptance requires samtools");

  progress("material");
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const prior = WorkflowAssetsSchema.parse(
    JSON.parse(await readText("/case-control/workflow-assets.json")),
  );
  const expectedBase = managedWorkflowPackage();
  progress("auth");
  const token = await (options.login ?? login)(serverOrigin);
  const send = options.request ?? jsonRequest;
  const request = (path: string, body?: unknown) => send(registryOrigin, token, path, body);

  progress("readback");
  const base = PackageSchema.parse(await request(`/usecase-packages/${prior.usecaseId}`));
  assert.equal(base.id, prior.usecaseId, "File workflow base package identity mismatch");
  assert.equal(base.name, "pr-managed-samtools-workflow", "File workflow base name mismatch");
  assert.equal(base.version, "1", "File workflow base version mismatch");
  assert.deepEqual(base.spec, expectedBase, "File workflow base package content mismatch");
  assert.equal(
    base.publishedSoftwareRevisionId,
    prior.softwareRevisionId,
    "File workflow base software revision mismatch",
  );

  const usecases: Record<string, string> = {};
  const seenIds = new Set([prior.usecaseId]);
  for (const nodeId of ["convert", "sort", "verify"] as const) {
    progress("usecase");
    const spec = usecase.GovernedUsecasePackageSchema.parse(fileWorkflowPackage(nodeId));
    assert.deepEqual(spec.softwareRef, expectedBase.softwareRef, "File workflow selector mismatch");
    assert.deepEqual(spec.software, expectedBase.software, "File workflow software spec mismatch");
    const create = usecase.UsecasePackageCreateSchema.parse({
      name: `pr-managed-samtools-file-workflow-${nodeId}`,
      version: "1",
      spec,
    });
    const created = PackageSchema.parse(await request("/usecase-packages", create));
    assert.equal(created.name, create.name, "File workflow package name mismatch");
    assert.equal(created.version, create.version, "File workflow package version mismatch");
    assert.deepEqual(created.spec, spec, "File workflow package content mismatch");
    assert(!seenIds.has(created.id), "File workflow packages must have distinct identities");

    progress("readback");
    const published = PackageSchema.parse(await request(`/usecase-packages/${created.id}`));
    assert.equal(published.id, created.id, "File workflow package identity mismatch");
    assert.equal(published.name, create.name, "File workflow published name mismatch");
    assert.equal(published.version, create.version, "File workflow published version mismatch");
    assert.deepEqual(published.spec, spec, "File workflow published package content mismatch");
    assert.equal(
      published.publishedSoftwareRevisionId,
      prior.softwareRevisionId,
      "File workflow package did not resolve the frozen software revision",
    );
    seenIds.add(created.id);
    usecases[nodeId] = created.id;
  }

  progress("receipt");
  const receipt = FileWorkflowAssetsSchema.parse({
    softwareRevisionId: prior.softwareRevisionId,
    usecases,
  });
  await (options.writeReceipt ?? writeReceipt)(receipt);
  return receipt;
}

if (import.meta.main) {
  let stage: FileWorkflowAssetsStage = "guard";
  try {
    await registerFileWorkflowAssets({
      onStage: (next) => {
        stage = next;
      },
    });
    console.log("Spack file workflow assets: status=succeeded");
  } catch {
    console.error(`Spack file workflow assets: stage=${stage} status=failed`);
    process.exitCode = 1;
  }
}
