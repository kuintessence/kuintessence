import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb } from "@kuintessence/db";
import { AppError, ErrorCode, ecosystemCanonicalJson } from "@kuintessence/shared";
import { EcosystemReleaseService } from "./ecosystem-release-service";
import { createOfflineDeliveryFixture } from "./offline-delivery.fixture";

test("signed material associations retain the real principal and reject mismatched catalog specs before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-signed-material-"));
  // This test must fail at validation/authorization before attempting any DB connection.
  const db = createPgDb("postgres://fixture@127.0.0.1:1/unavailable");
  try {
    const fixture = await createOfflineDeliveryFixture(join(root, "input"));
    const keys = generateKeyPairSync("ed25519");
    const manifest = {
      ...fixture.bundle.manifest,
      materialRequirements: [
        {
          ecosystemKey: "software/hello",
          spec: "hello@1.0",
          target: "linux-ubuntu24.04-x86_64",
          spackVersion: "1.0.0",
          binding: { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` },
        },
      ],
    };
    const bundle = () => ({
      manifest,
      signingKeyId: "test",
      signature: sign(
        null,
        Buffer.from(ecosystemCanonicalJson(manifest)),
        keys.privateKey,
      ).toString("base64"),
    });
    let calls = 0;
    const service = new EcosystemReleaseService(
      db,
      { test: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") },
      undefined,
      async (_requirements, actor) => {
        expect(actor).toBe("canonical-subject");
        calls++;
        throw new AppError(ErrorCode.FORBIDDEN, "Material visibility denied", 403);
      },
    );
    await expect(service.stage(bundle(), "canonical-subject")).rejects.toMatchObject({
      statusCode: 403,
    });
    const requirement = manifest.materialRequirements[0];
    if (!requirement) throw new Error("fixture");
    requirement.spec = "hello@9.9";
    await expect(service.stage(bundle(), "canonical-subject")).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(calls).toBe(1);
  } finally {
    await db.$client.end();
    await rm(root, { recursive: true, force: true });
  }
});
