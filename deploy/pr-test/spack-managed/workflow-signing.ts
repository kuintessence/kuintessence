import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";

export const workflowSigningKeyId = "pr-spack-managed-workflow";
export const workflowPrivateKeyPath = "/case-server/workflow-signing.pem";
export const workflowTrustedKeysPath = "/case-control/workflow-trusted-keys.json";

export interface WorkflowSigningOptions {
  getuid?: () => number | undefined;
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  writeExclusive?: (path: string, content: string, mode: number) => Promise<void>;
}

export function assertWorkflowTestMode(): void {
  assert.equal(process.env.KQ_PR_TEST, "1", "Workflow assets require PR test mode");
  assert.equal(process.env.KQ_PR_SPACK_WORKFLOW, "1", "Workflow acceptance is not enabled");
}

async function writeExclusive(path: string, content: string, mode: number): Promise<void> {
  const file = await open(path, "wx", mode);
  try {
    await file.writeFile(content);
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Run once in the ephemeral setup container, before Registry reads its trust configuration. */
export async function setupWorkflowSigning(options: WorkflowSigningOptions = {}): Promise<void> {
  assertWorkflowTestMode();
  assert.equal(
    (options.getuid ?? (() => process.getuid?.()))(),
    0,
    "Workflow signing setup requires root",
  );
  const makeDirectory = options.mkdir ?? mkdir;
  const write = options.writeExclusive ?? writeExclusive;
  await makeDirectory("/case-server", { recursive: true, mode: 0o700 });
  await makeDirectory("/case-control", { recursive: true, mode: 0o755 });
  const keys = generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicSpki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  // case-server is operator/Server-only; Agent and Registry see only the public case-control file.
  await write(workflowPrivateKeyPath, privatePem, 0o600);
  await write(
    workflowTrustedKeysPath,
    `${JSON.stringify({ [workflowSigningKeyId]: publicSpki })}\n`,
    0o444,
  );
}

if (import.meta.main) {
  try {
    await setupWorkflowSigning();
    console.log("Spack workflow signing setup: status=succeeded");
  } catch {
    console.error("Spack workflow signing setup: stage=setup status=failed");
    process.exitCode = 1;
  }
}
