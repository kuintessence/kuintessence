import { describe, expect, test } from "bun:test";
import {
  evaluateSharedServiceEligibility,
  hashSandboxScript,
  renderSandboxPrompt,
} from "./sandbox-script";

const HASH = "a".repeat(64);
const RUNTIME = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("Sandbox script governance", () => {
  test("hashes a frozen script deterministically", () => {
    expect(hashSandboxScript("print('ok')\n")).toBe(
      "ad64355106bb158b020ecf9702be48f7730fc091dd4bb6a2f092b40393495b3d",
    );
  });

  test("renders localized prompts with runtime and security constraints", () => {
    const prompt = renderSandboxPrompt({
      locale: "zh-CN",
      language: "python",
      runtimeName: "Python 3.13 scientific",
      runtimeDependencies: [{ name: "polars", version: "1.31.0" }],
      inputs: { source: { type: "JSON", required: true } },
      outputs: {
        result: {
          type: "File",
          required: true,
          validator: null,
          locality: { type: "FollowConsumer" },
          durability: "Persistent",
          sizeHint: { type: "SizeClass", value: "Small" },
        },
      },
    });
    expect(prompt).toContain("polars==1.31.0");
    expect(prompt).toContain("禁止联网");
    expect(prompt).toContain("/kq/outputs");
  });

  test("provider attestation does not cross CP boundaries", () => {
    const base = {
      assetLifecycle: "published",
      scriptSha256: HASH,
      runtimeProfileId: RUNTIME,
      attestations: [
        {
          scriptSha256: HASH,
          runtimeProfileId: RUNTIME,
          scope: "provider" as const,
          providerOrgId: "provider-a",
          status: "active" as const,
          allowedIdentities: [{ type: "SharedService" as const }],
          expiresAt: null,
        },
      ],
    };
    expect(evaluateSharedServiceEligibility({ ...base, providerOrgId: "provider-a" }).allowed).toBe(
      true,
    );
    expect(evaluateSharedServiceEligibility({ ...base, providerOrgId: "provider-b" }).allowed).toBe(
      false,
    );
  });

  test("new hash and expired attestations are rejected", () => {
    const result = evaluateSharedServiceEligibility({
      assetLifecycle: "published",
      scriptSha256: "b".repeat(64),
      runtimeProfileId: RUNTIME,
      providerOrgId: "provider-a",
      now: new Date("2026-07-14T00:00:00Z"),
      attestations: [
        {
          scriptSha256: HASH,
          runtimeProfileId: RUNTIME,
          scope: "platform",
          providerOrgId: null,
          status: "active",
          allowedIdentities: [{ type: "SharedService" }],
          expiresAt: new Date("2026-07-13T00:00:00Z"),
        },
      ],
    });
    expect(result).toEqual({ allowed: false, reason: "no matching active attestation" });
  });
});
