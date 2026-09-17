import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  orgs,
  type PgDb,
  usecasePackageRevisions,
  usecasePackages,
  users,
} from "@kuintessence/db";
import { ErrorCode } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { assertUsecasePackageExecutionAccess } from "./usecase-execution-authorizer";

const DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("Usecase execution authorization", () => {
  let db: PgDb;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let platformPackageId: string;
  let orgPackageId: string;
  let userPackageId: string;
  let userRevisionId: string;

  beforeAll(async () => {
    db = createPgDb(DB_URL);
    const [firstOrg, secondOrg] = await db
      .insert(orgs)
      .values([{ name: "test-usecase-auth-org-a" }, { name: "test-usecase-auth-org-b" }])
      .returning();
    if (!firstOrg || !secondOrg) throw new Error("failed to create test organizations");
    orgA = firstOrg.id;
    orgB = secondOrg.id;
    const [firstUser, secondUser] = await db
      .insert(users)
      .values([
        { email: "test-usecase-auth-a@kuintessence.test", externalId: "subject-a", role: "user" },
        { email: "test-usecase-auth-b@kuintessence.test", externalId: "subject-b", role: "user" },
      ])
      .returning();
    if (!firstUser || !secondUser) throw new Error("failed to create test users");
    userA = firstUser.id;
    userB = secondUser.id;
    const packageSpec = {
      usecase: { commandFile: "true", inputSlots: [] },
      software: { kind: "Bare" },
      arguments: [],
      environments: [],
      filesomeInputs: [],
      filesomeOutputs: [],
    };
    const [platformPackage, orgPackage, userPackage] = await db
      .insert(usecasePackages)
      .values([
        {
          name: "test-usecase-auth-platform",
          version: "1",
          spec: packageSpec,
          namespace: "platform",
        },
        {
          name: "test-usecase-auth-org",
          version: "1",
          spec: packageSpec,
          namespace: "org",
          ownerOrgId: orgA,
        },
        {
          name: "test-usecase-auth-user",
          version: "1",
          spec: packageSpec,
          namespace: "user",
          ownerSubject: "subject-a",
          ownerUserId: userA,
          createdBy: userA,
        },
      ])
      .returning();
    if (!platformPackage || !orgPackage || !userPackage)
      throw new Error("failed to create packages");
    platformPackageId = platformPackage.id;
    orgPackageId = orgPackage.id;
    userPackageId = userPackage.id;
    const [revision] = await db
      .insert(usecasePackageRevisions)
      .values({
        packageId: userPackageId,
        revision: 1,
        spec: packageSpec,
        specDigest: "sha256:test",
      })
      .returning();
    if (!revision) throw new Error("failed to create usecase revision");
    userRevisionId = revision.id;
  });

  afterAll(async () => {
    await db.delete(usecasePackages).where(eq(usecasePackages.id, platformPackageId));
    await db.delete(usecasePackages).where(eq(usecasePackages.id, orgPackageId));
    await db.delete(usecasePackages).where(eq(usecasePackages.id, userPackageId));
    await db.delete(users).where(eq(users.id, userA));
    await db.delete(users).where(eq(users.id, userB));
    await db.delete(orgs).where(eq(orgs.id, orgA));
    await db.delete(orgs).where(eq(orgs.id, orgB));
  });

  test("allows platform packages for every canonical requester", async () => {
    await expect(
      assertUsecasePackageExecutionAccess(db, platformPackageId, { userId: userB, orgId: null }),
    ).resolves.toBeUndefined();
  });

  test("allows only the active owner organization", async () => {
    await expect(
      assertUsecasePackageExecutionAccess(db, orgPackageId, { userId: userB, orgId: orgA }),
    ).resolves.toBeUndefined();
    await expect(
      assertUsecasePackageExecutionAccess(db, orgPackageId, { userId: userB, orgId: orgB }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN, statusCode: 403 });
    await expect(
      assertUsecasePackageExecutionAccess(db, orgPackageId, { userId: userB, orgId: null }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN, statusCode: 403 });
  });

  test("allows a user owner and rejects every other user, including by revision id", async () => {
    await expect(
      assertUsecasePackageExecutionAccess(db, userPackageId, { userId: userA, orgId: null }),
    ).resolves.toBeUndefined();
    await expect(
      assertUsecasePackageExecutionAccess(db, userRevisionId, { userId: userA, orgId: null }),
    ).resolves.toBeUndefined();
    await expect(
      assertUsecasePackageExecutionAccess(db, userPackageId, {
        userId: userB,
        orgId: null,
        subject: "subject-b",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN, statusCode: 403 });
  });

  test("returns 404 for an unknown package id", async () => {
    await expect(
      assertUsecasePackageExecutionAccess(db, "00000000-0000-4000-8000-000000000000", {
        userId: userA,
        orgId: null,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND, statusCode: 404 });
  });
});
