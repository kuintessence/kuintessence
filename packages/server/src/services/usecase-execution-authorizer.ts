import {
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
  usecasePackages,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";

export interface UsecaseExecutionRequester {
  userId: string;
  orgId: string | null;
  subject?: string | null;
}

interface UsecaseExecutionPackage {
  id: string;
  namespace: string;
  ownerSubject: string | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  createdBy: string | null;
}

export async function assertUsecasePackageExecutionAccess(
  db: PgDb,
  usecasePackageOrRevisionId: string,
  requester: UsecaseExecutionRequester,
): Promise<void> {
  const pkg = await loadUsecasePackageScope(db, usecasePackageOrRevisionId);
  if (!pkg) {
    throw new AppError(ErrorCode.NOT_FOUND, "Usecase package not found", 404);
  }
  if (pkg.namespace === "platform") return;
  if (pkg.namespace === "org" && pkg.ownerOrgId === requester.orgId) return;
  if (pkg.namespace !== "user") {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Usecase package is outside the active organization",
      403,
    );
  }
  if (pkg.ownerUserId === requester.userId || pkg.createdBy === requester.userId) return;
  if (pkg.ownerSubject && pkg.ownerSubject === requester.subject) return;
  if (!pkg.ownerSubject) {
    throw new AppError(ErrorCode.FORBIDDEN, "User usecase package is outside scope", 403);
  }
  const [owner] = await db
    .select({ externalId: users.externalId })
    .from(users)
    .where(eq(users.id, requester.userId))
    .limit(1);
  if (owner?.externalId === pkg.ownerSubject) return;
  throw new AppError(ErrorCode.FORBIDDEN, "User usecase package is outside scope", 403);
}

async function loadUsecasePackageScope(
  db: PgDb,
  usecasePackageOrRevisionId: string,
): Promise<UsecaseExecutionPackage | null> {
  const fields = {
    id: usecasePackages.id,
    namespace: usecasePackages.namespace,
    ownerSubject: usecasePackages.ownerSubject,
    ownerUserId: usecasePackages.ownerUserId,
    ownerOrgId: usecasePackages.ownerOrgId,
    createdBy: usecasePackages.createdBy,
  };
  const [pkg] = await db
    .select(fields)
    .from(usecasePackages)
    .where(eq(usecasePackages.id, usecasePackageOrRevisionId))
    .limit(1);
  if (pkg) return pkg;
  const [revision] = await db
    .select(fields)
    .from(usecasePackageRevisions)
    .innerJoin(usecasePackages, eq(usecasePackageRevisions.packageId, usecasePackages.id))
    .where(eq(usecasePackageRevisions.id, usecasePackageOrRevisionId))
    .limit(1);
  if (revision) return revision;
  const [assetRevision] = await db
    .select({ payload: softwareAssets.payload })
    .from(softwareAssetRevisions)
    .innerJoin(softwareAssets, eq(softwareAssetRevisions.assetId, softwareAssets.id))
    .where(
      and(
        eq(softwareAssetRevisions.id, usecasePackageOrRevisionId),
        eq(softwareAssets.kind, "usecase"),
      ),
    )
    .limit(1);
  const packageId = assetRevision?.payload.usecasePackageId;
  if (typeof packageId !== "string") return null;
  const [legacyPackage] = await db
    .select(fields)
    .from(usecasePackages)
    .where(eq(usecasePackages.id, packageId))
    .limit(1);
  return legacyPackage ?? null;
}
