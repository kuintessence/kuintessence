import { describe, expect, test } from "bun:test";
import type { EcosystemManifest } from "./ecosystem-release-service";
import {
  LicensedMaterialMappingInputSchema,
  stableDataProductCatalogReference,
  validateEcosystemManifest,
} from "./ecosystem-release-service";

const openLicense = {
  classification: "open-source",
  identifiers: [{ kind: "spdx", value: "MIT" }],
  provenance: { source: "platform-fork", reference: "https://example.invalid/catalog" },
  acceptanceRequired: false,
  providerEntitlements: [],
  consumerEntitlements: [],
  autoInstall: "denied",
  redistribution: "permitted",
};

function manifest(payload: Record<string, unknown>): EcosystemManifest {
  return {
    schemaVersion: 1,
    releaseKey: "data-product-test",
    version: "1.0.0",
    provenance: { source: "test" },
    assets: [
      {
        ecosystemKey: "data/qe-pslibrary",
        kind: "data-product",
        name: "QE PSLibrary",
        version: "1.0.0",
        payload,
        provenance: { source: "metadata-catalog" },
        licensePolicy: openLicense,
      },
    ],
  };
}

describe("ecosystem Data Market products", () => {
  test("accepts metadata-only data products without a location", () => {
    expect(() =>
      validateEcosystemManifest(
        manifest({
          kind: "data-product",
          dataAsset: {
            kind: "pseudopotential",
            selector: "qe-pslibrary",
            version: "1.0.0",
            description: "QE pseudopotential catalog metadata",
            tags: ["qe"],
            accessMode: "open",
            sensitivity: "open",
            deliveryPolicy: {},
            redistribution: "permitted",
            entitlementRequired: false,
          },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects byte-bearing or path-bearing data product payloads", () => {
    for (const forbidden of ["bytes", "path", "secret"]) {
      expect(() =>
        validateEcosystemManifest(
          manifest({
            kind: "data-product",
            dataAsset: {
              kind: "pseudopotential",
              selector: "qe-pslibrary",
              version: "1.0.0",
              description: "metadata",
              tags: [],
              accessMode: "open",
              sensitivity: "open",
              deliveryPolicy: {},
              redistribution: "permitted",
              entitlementRequired: false,
              [forbidden]: "forbidden",
            },
          }),
        ),
      ).toThrow("DataProductPayload");
    }
  });

  test("exports stable Data Market ids for workflow selectors", () => {
    const selector = {
      kind: "pseudopotential",
      selector: "qe-pslibrary",
      version: "1.0.0",
    };
    const first = stableDataProductCatalogReference(selector);
    expect(stableDataProductCatalogReference(selector)).toEqual(first);
    expect(first).toMatchObject(selector);
    expect(first.dataAssetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.dataAssetVersionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("licensed material audit metadata", () => {
  const input = {
    providerOrgId: "11111111-1111-4111-8111-111111111111",
    agentId: "agent-1",
    selector: "vasp-potcar-pbe",
    assetId: "22222222-2222-4222-8222-222222222222",
    materialName: "VASP POTCAR PBE",
    materialVersion: "2025.1",
    elementSet: ["H"],
    fingerprint: "sha256:metadata-only",
  };

  test("rejects POTCAR bytes and recursively sensitive metadata keys", () => {
    expect(
      LicensedMaterialMappingInputSchema.safeParse({
        ...input,
        auditMetadata: { potcarBytes: "forbidden" },
      }).success,
    ).toBe(false);
    expect(
      LicensedMaterialMappingInputSchema.safeParse({
        ...input,
        auditMetadata: { labels: { nestedToken: "forbidden" } },
      }).success,
    ).toBe(false);
  });

  test("accepts only bounded audit metadata fields", () => {
    expect(
      LicensedMaterialMappingInputSchema.safeParse({
        ...input,
        auditMetadata: {
          source: "provider inventory",
          validationMethod: "fingerprint comparison",
          labels: { environment: "production" },
        },
      }).success,
    ).toBe(true);
    expect(
      LicensedMaterialMappingInputSchema.safeParse({
        ...input,
        auditMetadata: {
          labels: Object.fromEntries(
            Array.from({ length: 80 }, (_, index) => [`label-${index}`, "x".repeat(255)]),
          ),
        },
      }).success,
    ).toBe(false);
  });
});
