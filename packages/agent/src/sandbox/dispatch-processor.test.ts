import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  SandboxExecutionSchema,
  SandboxIdentityMode,
  SandboxIoType,
  SandboxLanguage,
  SandboxMountMode,
  SandboxRuntimeKind,
} from "@kuintessence/proto";
import { canonicalJson } from "@kuintessence/shared";
import { SandboxDispatchProcessor } from "./dispatch-processor";
import { SandboxManifestVerifier } from "./manifest-verifier";
import { decodeSandboxExecution } from "./proto-manifest";
import { SandboxStager } from "./stager";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

test.each([
  "fresh",
  "restart",
  "invalid",
  "aborted",
] as const)("Sandbox preparation cleans only verified work: %s", async (mode) => {
  const parent = await mkdtemp(join(tmpdir(), "kq-sandbox-prepare-"));
  roots.push(parent);
  const root = join(parent, "runs"),
    jobId = randomUUID();
  const target = join(root, jobId, "inputs/data");
  if (mode !== "fresh") {
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await writeFile(target, "old input");
  }
  const script = { language: "python", entrypoint: "main.py", sha256: hash("print('ok')") };
  const runtimeDigest = `sha256:${"a".repeat(64)}`;
  const execution = create(SandboxExecutionSchema, {
    script: {
      language: SandboxLanguage.PYTHON,
      entrypoint: script.entrypoint,
      content: Buffer.from("print('ok')"),
      sha256: script.sha256,
      bundleSha256: hash(canonicalJson(script)),
    },
    runtime: { profileId: randomUUID(), kind: SandboxRuntimeKind.OCI, digest: runtimeDigest },
    executionMode: "RootImpersonation",
    executionIdentity: {
      mode: SandboxIdentityMode.MAPPED_ACCOUNT,
      accountId: randomUUID(),
      backend: { case: "kubernetes", value: { namespace: "jobs", serviceAccount: "worker" } },
    },
    artifactMounts: [
      {
        descriptor: "data",
        ioType: SandboxIoType.FILE,
        mode: SandboxMountMode.READ_ONLY,
        relativePath: "inputs/data",
        containerPath: "/kq/inputs/data",
        expectedSha256: hash("new input"),
        sizeLimitBytes: 100n,
        required: true,
      },
    ],
    limits: { pids: 16, outputBytes: 100n, logBytes: 100n },
    networkDisabled: true,
    envelope: {
      keyId: "test",
      nonce: randomUUID(),
      issuedAtUnixMs: BigInt(Date.now() - 1_000),
      expiresAtUnixMs: BigInt(Date.now() + 60_000),
      manifestSha256: "a".repeat(64),
      signature: Buffer.from("placeholder"),
    },
  });
  const { envelope: _envelope, ...unsigned } = decodeSandboxExecution(jobId, execution);
  const json = canonicalJson(unsigned);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  if (!execution.envelope) throw new Error("Missing test envelope");
  execution.envelope.manifestSha256 = hash(json);
  execution.envelope.signature = sign(null, Buffer.from(json), privateKey);
  if (mode === "invalid") execution.envelope.signature = new Uint8Array(64);
  const verifier = new SandboxManifestVerifier({
    publicKeys: { test: publicKey.export({ type: "spki", format: "pem" }).toString() },
    runtimeCache: {
      [runtimeDigest]: { kind: "OCI", localPath: "registry.test/runtime", signatureVerified: true },
    },
    nonceConsumer: { consume: async () => true },
    accountVerifier: { verify: async () => true },
    adapterType: "kubernetes",
    localExecutionMode: "RootImpersonation",
    rootImpersonationEnabled: true,
    sharedServiceAllowed: false,
  });
  const controller = new AbortController();
  const interrupted = new Error("Preparation authority expired");
  let downloads = 0;
  const processor = new SandboxDispatchProcessor(
    verifier,
    new SandboxStager({
      root,
      downloadInput: async ({ targetPath }) => {
        downloads++;
        expect(await Bun.file(targetPath).exists()).toBe(false);
        await writeFile(targetPath, "new input");
        if (mode === "aborted") controller.abort(interrupted);
      },
    }),
  );
  const preparation = processor.prepare(
    jobId,
    execution,
    [{ stagePath: "inputs/data", sourceUrl: "https://objects.test/input" }],
    { restart: true, signal: controller.signal },
  );
  if (mode === "invalid") {
    await expect(preparation).rejects.toThrow("signature verification failed");
    expect(downloads).toBe(0);
    expect(await readFile(target, "utf8")).toBe("old input");
  } else if (mode === "aborted") {
    await expect(preparation).rejects.toBe(interrupted);
    expect(await Bun.file(target).exists()).toBe(false);
    await expect(readFile(join(root, jobId))).rejects.toMatchObject({ code: "ENOENT" });
    execution.envelope.nonce = randomUUID();
    await processor.prepare(
      jobId,
      execution,
      [{ stagePath: "inputs/data", sourceUrl: "https://objects.test/input" }],
      { restart: true, signal: new AbortController().signal },
    );
    expect(await readFile(target, "utf8")).toBe("new input");
  } else {
    expect((await preparation).runtimeDigest).toBe(runtimeDigest);
    expect(downloads).toBe(1);
    expect(await readFile(target, "utf8")).toBe("new input");
  }
});
