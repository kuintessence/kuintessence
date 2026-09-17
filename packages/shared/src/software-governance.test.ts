import { describe, expect, test } from "bun:test";
import {
  LicensePolicySchema,
  propagateLicenseRequirements,
  SandboxRuntimeContractSchema,
} from "./software-governance";

describe("LicensePolicySchema", () => {
  test("models VASP as a proprietary, entitlement-gated policy", () => {
    const policy = LicensePolicySchema.parse({
      classification: "proprietary",
      identifiers: [{ kind: "custom", value: "VASP-license" }],
      termsUrl: "https://www.vasp.at/",
      provenance: { source: "official-upstream", reference: "VASP license terms" },
      acceptanceRequired: true,
      providerEntitlements: ["source-access", "install"],
      consumerEntitlements: ["use"],
      redistribution: "prohibited",
      autoInstall: "denied",
    });
    expect(policy.autoInstall).toBe("denied");
  });

  test("propagates and de-duplicates inherited requirements", () => {
    expect(
      propagateLicenseRequirements([
        [{ identifier: "GPL-3.0-or-later", requiredEntitlements: ["consumer-use"] }],
        [
          {
            identifier: "GPL-3.0-or-later",
            requiredEntitlements: ["provider-install", "consumer-use"],
          },
        ],
      ]),
    ).toEqual([
      {
        identifier: "GPL-3.0-or-later",
        requiredEntitlements: ["consumer-use", "provider-install"],
      },
    ]);
  });
});

describe("SandboxRuntimeContractSchema", () => {
  test("describes the stdlib-only Python 3.12 logical runtime", () => {
    expect(
      SandboxRuntimeContractSchema.parse({
        name: "python-stdlib",
        version: "3.12-v1",
        language: "python",
        pythonVersion: "3.12",
        stdlibOnly: true,
      }),
    ).toMatchObject({ stdlibOnly: true });
  });
});
