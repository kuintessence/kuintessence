import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { collectedForJobCompletion } from "../grpc/agent-handler";
import {
  acceptsTrustedMaterialization,
  verifiesTrustedEcosystemSandboxScriptBinding,
  verifiesTrustedEcosystemUsecaseBinding,
} from "./job-service";
import { restrictToIsolatedAgents } from "./placement-orchestrator";
import { assertRestrictedNoEgressSubmission } from "./restricted-no-egress";

const restrictedFacts = [
  {
    assetKind: "pseudopotential" as const,
    sensitivity: "restricted" as const,
    egressPolicy: "deny" as const,
  },
];

describe("restricted no-egress submission guard", () => {
  test("fails closed when a signed release package is mutated after materialization", () => {
    const spec = { command: "trusted-run", inputs: [] };
    const specDigest = digest(spec);
    const entry = {
      ecosystemKey: "usecase/trusted",
      kind: "usecase",
      name: "Trusted",
      version: "1.0.0",
      payload: { kind: "usecase", spec },
      provenance: { source: "official" },
      licensePolicy: {},
      specDigest,
    };
    const manifest = {
      schemaVersion: 1,
      releaseKey: "trusted-ecosystem",
      version: "1.0.0",
      provenance: { source: "official" },
      assets: [entry],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString(
      "base64",
    );
    const binding = {
      artifactDigest: digest(manifest),
      manifest,
      manifestEntryDigest: digest(entry),
      manifestEntryDigestKey: entry.ecosystemKey,
      packageSpec: spec,
      packageSpecDigest: specDigest,
      provenance: {
        ecosystemRelease: {
          releaseKey: manifest.releaseKey,
          artifactDigest: digest(manifest),
          manifestEntryDigest: digest(entry),
          signingKeyId: "release-key",
        },
      },
      releaseKey: manifest.releaseKey,
      revisionSpec: spec,
      revisionSpecDigest: specDigest,
      signature,
      signingKeyId: "release-key",
      usecaseSpecDigest: specDigest,
    };
    const trustedKeys = {
      "release-key": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };

    expect(verifiesTrustedEcosystemUsecaseBinding(binding, trustedKeys)).toBe(true);
    expect(
      verifiesTrustedEcosystemUsecaseBinding(
        { ...binding, packageSpec: { command: "exfiltrate", inputs: [] } },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemUsecaseBinding(
        { ...binding, revisionSpec: { command: "exfiltrate", inputs: [] } },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemUsecaseBinding({ ...binding, signature: "forged" }, trustedKeys),
    ).toBe(false);
  });

  test("does not trust a caller-spoofed ecosystem usecase id", () => {
    expect(acceptsTrustedMaterialization({}, true)).toBe(false);
    expect(acceptsTrustedMaterialization({ trustedMaterialization: true }, true)).toBe(true);
  });

  test("binds a trusted Sandbox script to its signed release and resolved content", () => {
    const content = "print('safe')";
    const payload = {
      kind: "sandbox-script",
      language: "python",
      entrypoint: "main.py",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      inputs: {},
      outputs: {},
    };
    const entry = {
      ecosystemKey: "sandbox/trusted",
      kind: "sandbox-script",
      name: "Trusted Sandbox",
      version: "1.0.0",
      payload,
      provenance: { source: "official" },
      licensePolicy: {},
    };
    const manifest = {
      schemaVersion: 1,
      releaseKey: "trusted-ecosystem",
      version: "1.0.0",
      provenance: { source: "official" },
      assets: [entry],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString(
      "base64",
    );
    const binding = {
      entryPayload: payload,
      manifest,
      manifestEntryDigest: digest(entry),
      manifestEntryDigestKey: entry.ecosystemKey,
      releaseKey: manifest.releaseKey,
      revisionPayload: payload,
      signature,
      signingKeyId: "release-key",
      sourceSha256: payload.sha256,
    };
    const trustedKeys = {
      "release-key": keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };

    expect(verifiesTrustedEcosystemSandboxScriptBinding(binding, trustedKeys)).toBe(true);
    expect(
      verifiesTrustedEcosystemSandboxScriptBinding(
        { ...binding, revisionPayload: { ...payload, content: "print('changed')" } },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemSandboxScriptBinding(
        { ...binding, entryPayload: { ...payload, content: "print('changed')" } },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemSandboxScriptBinding(
        { ...binding, sourceSha256: "0".repeat(64) },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemSandboxScriptBinding(
        { ...binding, signature: "forged" },
        trustedKeys,
      ),
    ).toBe(false);
    expect(
      verifiesTrustedEcosystemSandboxScriptBinding(
        { ...binding, releaseKey: "another-release" },
        trustedKeys,
      ),
    ).toBe(false);
    expect(verifiesTrustedEcosystemSandboxScriptBinding(binding, {})).toBe(false);
  });

  test("requires an explicitly advertised isolation capability", () => {
    const agents = [
      { agentId: "legacy", restrictedDataIsolation: false },
      { agentId: "trusted", restrictedDataIsolation: true },
    ];
    expect(restrictToIsolatedAgents(agents, true)).toEqual([
      { agentId: "trusted", restrictedDataIsolation: true },
    ]);
    expect(restrictToIsolatedAgents(agents, false)).toEqual(agents);
  });

  test("treats licensed material as no-egress even if legacy policy says allow", () => {
    expect(() =>
      assertRestrictedNoEgressSubmission({
        facts: [
          {
            assetKind: "licensed-material",
            sensitivity: "open",
            egressPolicy: "allow",
          },
        ],
        hasLicensedMaterialMounts: false,
        trustedExecutable: false,
        expectedOutputCount: 0,
        fileOutputDescriptorCount: 0,
      }),
    ).toThrow("trusted executable");
  });

  test("discards output returned by an untrusted or stale Agent", () => {
    expect(collectedForJobCompletion(true, { stdout: "secret", artifact: "base64-data" })).toEqual(
      {},
    );
  });

  for (const command of [
    "cp inputs/potcar outputs/potcar",
    "base64 inputs/potcar",
    "cat inputs/potcar",
  ]) {
    test(`rejects raw command exfiltration: ${command.split(" ")[0]}`, () => {
      expect(() =>
        assertRestrictedNoEgressSubmission({
          facts: restrictedFacts,
          hasLicensedMaterialMounts: false,
          trustedExecutable: false,
          expectedOutputCount: 0,
          fileOutputDescriptorCount: 0,
        }),
      ).toThrow("trusted executable");
    });
  }

  test("rejects stdout or artifact declarations for a trusted no-egress usecase", () => {
    expect(() =>
      assertRestrictedNoEgressSubmission({
        facts: restrictedFacts,
        hasLicensedMaterialMounts: false,
        trustedExecutable: true,
        expectedOutputCount: 1,
        fileOutputDescriptorCount: 1,
      }),
    ).toThrow("cannot declare outputs");
  });

  test("allows an output-free trusted usecase and an independent postprocess job", () => {
    expect(
      assertRestrictedNoEgressSubmission({
        facts: restrictedFacts,
        hasLicensedMaterialMounts: false,
        trustedExecutable: true,
        expectedOutputCount: 0,
        fileOutputDescriptorCount: 0,
      }),
    ).toBe(true);
    expect(
      assertRestrictedNoEgressSubmission({
        facts: [],
        hasLicensedMaterialMounts: false,
        trustedExecutable: false,
        expectedOutputCount: 1,
        fileOutputDescriptorCount: 1,
      }),
    ).toBe(false);
  });
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
