import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  LicensePolicySchema,
  SoftwareAssetPayloadSchema,
  usecase,
} from "@kuintessence/shared";
import { createPackageResolver } from "./package-resolver";

const fixtureRoot = resolve(import.meta.dir, "../../../../deploy/schedulers/fixtures");

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtureRoot, name), "utf8"));
}

describe("scheduler workflow smoke fixtures", () => {
  test.each([
    "governed-shell-usecase.json",
    "governed-batch-usecase.json",
  ])("%s satisfies the governed frozen-revision contract", async (name) => {
    const spec = usecase.GovernedUsecasePackageSchema.parse(await readFixture(name));
    const revision = SoftwareAssetPayloadSchema.parse(
      await readFixture("governed-software-revision.json"),
    );
    const licensePolicy = LicensePolicySchema.parse(
      await readFixture("governed-license-policy.json"),
    );
    expect(spec.software.kind).toBe("Spack");
    expect(revision.kind).toBe("spack-package");
    const recipeSha256 = createHash("sha256").update(canonicalJson(revision)).digest("hex");
    expect(recipeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(licensePolicy).toMatchObject({
      classification: "open-source",
      identifiers: [{ kind: "spdx", value: "Zlib" }],
      acceptanceRequired: false,
      providerEntitlements: [],
      consumerEntitlements: [],
    });

    const resolved = await createPackageResolver({
      getById: async () => ({ spec }),
      getSoftwareRevision: async () => ({
        asset: {
          id: "77777777-7777-4777-8777-777777777777",
          source: spec.softwareRef.source,
          name: spec.softwareRef.name,
          version: spec.softwareRef.version,
          providerOrgId: spec.softwareRef.providerOrgId ?? null,
        },
        payload: revision,
        recipeSha256,
        contentSha256: null,
      }),
    })("88888888-8888-4888-8888-888888888101", "88888888-8888-4888-8888-888888888202");

    expect(resolved.software).toMatchObject({
      kind: "Spack",
      name: "zlib@1.3.1",
    });
    expect(resolved.softwareRequirements).toEqual([
      {
        assetId: "77777777-7777-4777-8777-777777777777",
        name: "zlib",
        version: "1.3.1",
        installable: false,
      },
    ]);
  });
});
