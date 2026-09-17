import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createPgDb,
  orgs,
  type PgDb,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import { EcosystemReleaseService } from "./ecosystem-release-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PROVIDER_NAME = "runtime-binding-governance-test-provider";
const PROFILE_PREFIX = "runtime-binding-governance-test-";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const ATTESTATION_KEYS = generateKeyPairSync("ed25519");
const ATTESTATION_KEY_ID = "runtime-test-key";
const ATTESTATION_PUBLIC_KEY = ATTESTATION_KEYS.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

describe("Ecosystem runtime contract bindings", () => {
  let db: PgDb;
  let service: EcosystemReleaseService;
  let providerOrgId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new EcosystemReleaseService(db, { [ATTESTATION_KEY_ID]: ATTESTATION_PUBLIC_KEY });
    const [org] = await db.insert(orgs).values({ name: PROVIDER_NAME }).returning();
    if (!org) throw new Error("test provider organization was not created");
    providerOrgId = org.id;
  });

  afterAll(async () => {
    await db
      .delete(sandboxRuntimeContractBindings)
      .where(eq(sandboxRuntimeContractBindings.providerOrgId, providerOrgId));
    await db
      .delete(sandboxRuntimeProfiles)
      .where(eq(sandboxRuntimeProfiles.name, `${PROFILE_PREFIX}active`));
    await db
      .delete(sandboxRuntimeProfiles)
      .where(eq(sandboxRuntimeProfiles.name, `${PROFILE_PREFIX}draft`));
    await db
      .delete(sandboxRuntimeProfiles)
      .where(eq(sandboxRuntimeProfiles.name, `${PROFILE_PREFIX}unsigned`));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
  });

  test("binds only an active signed profile with its exact stored digest", async () => {
    const active = await insertProfile(db, "active", {
      lifecycle: "active",
      signature: "trusted",
      securityRequirements: { signingKeyId: ATTESTATION_KEY_ID },
    });
    const binding = bindingInput(providerOrgId, active.id, DIGEST);
    await expect(service.bindRuntimeContract(binding, "test")).resolves.toMatchObject({
      runtimeProfileId: active.id,
      runtimeDigest: DIGEST,
    });

    await expect(
      service.bindRuntimeContract(bindingInput(providerOrgId, active.id, OTHER_DIGEST), "test"),
    ).rejects.toThrow("Runtime digest does not match active signed runtime profile");
  });

  test("rejects inactive or unsigned runtime profiles", async () => {
    const draft = await insertProfile(db, "draft", {
      lifecycle: "draft",
      signature: "trusted",
      securityRequirements: { signingKeyId: ATTESTATION_KEY_ID },
    });
    await expect(
      service.bindRuntimeContract(
        bindingInput(providerOrgId, draft.id, draft.ociDigest ?? ""),
        "test",
      ),
    ).rejects.toThrow("Runtime profile must be active");

    const unsigned = await insertProfile(db, "unsigned", {
      lifecycle: "active",
      signature: "",
      securityRequirements: { signingKeyId: ATTESTATION_KEY_ID },
    });
    await expect(
      service.bindRuntimeContract(
        bindingInput(providerOrgId, unsigned.id, unsigned.ociDigest ?? ""),
        "test",
      ),
    ).rejects.toThrow("Runtime attestation verification failed");
  });

  test("upserts the provider-wide null scope as one binding", async () => {
    const active = await db
      .select()
      .from(sandboxRuntimeProfiles)
      .where(eq(sandboxRuntimeProfiles.name, `${PROFILE_PREFIX}active`))
      .limit(1);
    const profile = active[0];
    if (!profile) throw new Error("active test profile is missing");
    const input = bindingInput(providerOrgId, profile.id, DIGEST);
    await service.bindRuntimeContract(input, "test");
    await service.bindRuntimeContract(input, "test");
    const rows = await db
      .select()
      .from(sandboxRuntimeContractBindings)
      .where(
        and(
          eq(sandboxRuntimeContractBindings.providerOrgId, providerOrgId),
          eq(sandboxRuntimeContractBindings.runtimeContractRef, input.runtimeContractRef),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

function bindingInput(providerOrgId: string, runtimeProfileId: string, runtimeDigest: string) {
  return {
    providerOrgId,
    runtimeContractRef: "python-3.12-stdlib-v1",
    runtimeProfileId,
    runtimeDigest,
  };
}

async function insertProfile(
  db: PgDb,
  suffix: "active" | "draft" | "unsigned",
  input: {
    lifecycle: "active" | "draft";
    signature: string;
    securityRequirements: Record<string, unknown>;
  },
) {
  const [profile] = await db
    .insert(sandboxRuntimeProfiles)
    .values({
      name: `${PROFILE_PREFIX}${suffix}`,
      language: "python",
      languageVersion: "3.12.0",
      ociDigest: `sha256:${profileDigestCharacter(suffix).repeat(64)}`,
      sifDigest: null,
      signature:
        input.signature === "trusted"
          ? runtimeAttestationSignature(
              `${PROFILE_PREFIX}${suffix}`,
              `sha256:${profileDigestCharacter(suffix).repeat(64)}`,
            )
          : input.signature,
      dependencies: [],
      documentation: {},
      adapters: ["kubernetes"],
      securityRequirements: input.securityRequirements,
      lifecycle: input.lifecycle,
      createdBy: null,
    })
    .returning();
  if (!profile) throw new Error("test runtime profile was not created");
  return profile;
}

function runtimeAttestationSignature(name: string, runtimeDigest: string): string {
  const payload = JSON.stringify({
    language: "python",
    languageVersion: "3.12.0",
    name,
    runtimeDigest,
  });
  return sign(null, Buffer.from(payload), ATTESTATION_KEYS.privateKey).toString("base64");
}

function profileDigestCharacter(suffix: "active" | "draft" | "unsigned"): "a" | "b" | "c" {
  if (suffix === "active") return "a";
  if (suffix === "draft") return "b";
  return "c";
}
