import {
  dataLocations,
  dataReplicas,
  netdriveFiles,
  netdriveReplicas,
  type PgDb,
} from "@kuintessence/db";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  eligibleReplicaIds,
  importedNetdriveReplicas,
  REPLICA_VERIFICATION_TTL_MS,
} from "../services/data-replica";

const fileIdSchema = z.guid();

export async function deriveDataSites(
  db: PgDb,
  fileIds: string[],
  ownerId: string,
  orgId: string | null,
  now = new Date(),
): Promise<string[]> {
  const ids = [...new Set(fileIds)].filter((id) => fileIdSchema.safeParse(id).success);
  if (ids.length === 0) return [];
  const owned = [
    inArray(netdriveFiles.id, ids),
    eq(netdriveFiles.ownerId, ownerId),
    isNull(netdriveFiles.deletedAt),
  ];
  const confirmed = await db
    .selectDistinct({ siteId: netdriveReplicas.siteId })
    .from(netdriveReplicas)
    .innerJoin(netdriveFiles, eq(netdriveFiles.id, netdriveReplicas.fileId))
    .where(
      and(
        ...owned,
        eq(netdriveReplicas.status, "available"),
        eq(netdriveReplicas.sha256, netdriveFiles.sha256),
        eq(netdriveReplicas.size, netdriveFiles.size),
        gt(netdriveReplicas.lastSeenAt, new Date(now.getTime() - REPLICA_VERIFICATION_TTL_MS)),
        lte(netdriveReplicas.lastSeenAt, now),
      ),
    );
  const sites = new Set(confirmed.map((row) => row.siteId));
  if (orgId) {
    const candidates = await importedNetdriveReplicas(
      db,
      ...owned,
      eq(dataLocations.providerOrgId, orgId),
      eq(dataReplicas.status, "available"),
    );
    const eligible = await eligibleReplicaIds(
      db,
      candidates.map((row) => row.replicaId),
      now,
    );
    for (const row of candidates) if (eligible.has(row.replicaId)) sites.add(row.siteId);
  }
  return [...sites];
}
