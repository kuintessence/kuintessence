import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLog,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  users,
} from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { EcosystemReleaseService } from "./ecosystem-release-service";
import { OfflineDeliveryService } from "./offline-delivery";
import { createOfflineDeliveryFixture } from "./offline-delivery.fixture";
import { PgDeliveryReceipts } from "./offline-delivery-receipts";
import { seedOfflineDelivery } from "./offline-delivery-seed";
import { RecipeGitStore } from "./recipe-git-store";
import { SpackMaterialStore } from "./spack-material-store";

test("first local seed and subsequent runtime import share real PostgreSQL ecosystem identities and durable receipts", async () => {
  const url = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
  const db = createPgDb(url, { max: 2 });
  const lockDb = createPgDb(url, { max: 2 });
  const root = await mkdtemp(join(tmpdir(), "kq-delivery-pg-"));
  const subject = randomUUID();
  let releaseId: string | undefined;
  try {
    await db
      .insert(users)
      .values({ id: subject, email: `${subject}@example.invalid`, role: "super_admin" });
    const f = await createOfflineDeliveryFixture(join(root, "input"));
    const recipes = new RecipeGitStore(join(root, "recipes"));
    const materials = new SpackMaterialStore(join(root, "materials"), recipes);
    const ecosystem = new EcosystemReleaseService(db, f.trustedKeys);
    const options = {
      recipes,
      materials,
      ecosystem,
      receipts: new PgDeliveryReceipts(db, lockDb),
      trustedKeys: f.trustedKeys,
      bindings: {
        inspect: async () => {
          throw new Error("unexpected binding");
        },
        change: async () => {
          throw new Error("unexpected binding");
        },
      },
      resolvePrincipal: async (id: string) => {
        const [user] = await db.select().from(users).where(eq(users.id, id));
        return user?.role === "super_admin"
          ? { sub: user.id, role: "super_admin" as const, orgIds: [], suspended: user.suspended }
          : null;
      },
    };
    const service = new OfflineDeliveryService(options);
    const first = await seedOfflineDelivery(service, join(root, "input/delivery.json"), subject);
    expect(first.status).toBe("completed");
    const releases = await ecosystem.list("offline-contract-fixture");
    expect(releases).toHaveLength(1);
    releaseId = releases[0]?.id;
    const restarted = new OfflineDeliveryService({
      ...options,
      receipts: new PgDeliveryReceipts(db, lockDb),
    });
    const [second, concurrentSeed] = await Promise.all([
      restarted.run(f.plan, subject),
      seedOfflineDelivery(
        new OfflineDeliveryService({ ...options, receipts: new PgDeliveryReceipts(db, lockDb) }),
        join(root, "input/delivery.json"),
        subject,
      ),
    ]);
    expect(concurrentSeed.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(second.items[1]?.receipt).toEqual(first.items[1]?.receipt);
    expect(second.items[2]?.receipt).toEqual(first.items[2]?.receipt);
    expect(await ecosystem.list("offline-contract-fixture")).toHaveLength(1);
    expect((await restarted.history(f.plan, subject)).length).toBeGreaterThan(3);
    expect(
      await db
        .select()
        .from(ecosystemReleaseAssets)
        .where(eq(ecosystemReleaseAssets.releaseId, releaseId ?? "")),
    ).toHaveLength(1);
  } finally {
    if (releaseId) {
      await db
        .delete(ecosystemReleaseAssets)
        .where(eq(ecosystemReleaseAssets.releaseId, releaseId));
      await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, releaseId));
    }
    await db.delete(auditLog).where(eq(auditLog.actor, subject));
    await db.delete(users).where(eq(users.id, subject));
    await db.$client.end();
    await lockDb.$client.end();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
