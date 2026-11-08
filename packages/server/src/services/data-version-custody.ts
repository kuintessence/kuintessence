import {
  dataAssets,
  dataAssetVersions,
  type PgTransaction,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { isFederationDataset } from "../federation/dataset-authority";

/** Custody is necessary for giving another institution rights; generic manage grants are insufficient. */
export async function readDataVersionCustody(
  tx: PgTransaction,
  actor: { userId: string; orgId: string | null },
  versionId: string,
  write: boolean,
) {
  const [member] = await tx
    .select({ user: users, membership: userOrgMemberships })
    .from(users)
    .innerJoin(
      userOrgMemberships,
      and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, actor.orgId ?? "")),
    )
    .where(eq(users.id, actor.userId))
    .for("share", { of: [users, userOrgMemberships] });
  if (!member || member.user.suspended || member.user.serviceAccount || !actor.orgId) denied();
  const [data] = await tx
    .select({ asset: dataAssets, version: dataAssetVersions })
    .from(dataAssetVersions)
    .innerJoin(dataAssets, eq(dataAssets.id, dataAssetVersions.dataAssetId))
    .where(eq(dataAssetVersions.id, versionId))
    .for(write ? "update" : "share", { of: [dataAssets, dataAssetVersions] });
  if (!data || (await isFederationDataset(tx, data.asset.id))) denied();
  const owns = data.asset.ownerKind === "user" && data.asset.ownerUserId === actor.userId;
  const managesOrg =
    ["owner", "admin"].includes(member.membership.role) ||
    ["org_admin", "platform_admin", "super_admin"].includes(member.user.role);
  const orgOwns = data.asset.ownerOrgId === actor.orgId || data.asset.providerOrgId === actor.orgId;
  if (!owns && !(orgOwns && managesOrg)) denied();
  return { ...data, member };
}
function denied(): never {
  throw new AppError(
    ErrorCode.FORBIDDEN,
    "Data disclosure requires current asset management authority",
    403,
  );
}
