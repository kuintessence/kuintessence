import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { canonicalJson } from "@kuintessence/shared";
import {
  SandboxManifestSigner,
  sandboxBundleSha256,
  sandboxSha256,
} from "./sandbox-manifest-signer";

const JOB_ID = "00000000-0000-0000-0000-000000000111";
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000222";
const PROFILE_ID = "00000000-0000-0000-0000-000000000333";

function fixture() {
  const content = Buffer.from("print('ok')\n");
  const script = {
    language: "python" as const,
    entrypoint: "main.py",
    contentBase64: content.toString("base64"),
    sha256: sandboxSha256(content),
    bundleSha256: "",
  };
  script.bundleSha256 = sandboxBundleSha256(script);
  return {
    jobId: JOB_ID,
    script,
    runtime: {
      profileId: PROFILE_ID,
      kind: "SIF" as const,
      digest: `sha256:${"1".repeat(64)}`,
    },
    executionMode: "RootImpersonation" as const,
    identity: {
      mode: "MappedAccount" as const,
      accountId: ACCOUNT_ID,
      backend: "Unix" as const,
      username: "scientist",
      uid: 1001,
      gid: 1001,
      schedulerAccount: "science",
      allowedQueues: ["compute"],
    },
    mounts: [],
    limits: { pids: 64, outputBytes: 1_000_000, logBytes: 100_000 },
    networkDisabled: true as const,
  };
}

describe("SandboxManifestSigner", () => {
  test("pins the canonical manifest hash and emits a valid Ed25519 signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = new SandboxManifestSigner({
      keyId: "platform-2026-01",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      now: () => 1_720_915_200_000,
      nonce: () => "nonce-1234567890123456",
    });
    const signed = signer.sign(fixture());
    const { envelope: _envelope, ...unsigned } = signed;
    expect(signed.envelope.manifestSha256).toBe(sandboxSha256(canonicalJson(unsigned)));
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(unsigned)),
        publicKey,
        Buffer.from(signed.envelope.signatureBase64, "base64"),
      ),
    ).toBe(true);
  });

  test("rejects script bytes that do not match the pinned hash", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new SandboxManifestSigner({
      keyId: "key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const value = fixture();
    value.script.contentBase64 = Buffer.from("tampered").toString("base64");
    expect(() => signer.sign(value)).toThrow("content hash mismatch");
  });
});
