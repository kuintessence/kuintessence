import { netdriveTransferLog, type PgDb } from "@kuintessence/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

/**
 * Derive the set of site IDs that already hold the given NetDrive files, from
 * `netdrive_transfer_log` mirror records (`direction='mirror'`, `site_id` =
 * destination). Returns distinct site IDs.
 *
 * Cross-site replication is allowed to be partial: when no mirror rows exist,
 * the scorer simply receives no derived locality hint and placement continues.
 */
export async function deriveDataSites(db: PgDb, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ siteId: netdriveTransferLog.siteId })
    .from(netdriveTransferLog)
    .where(
      and(
        inArray(netdriveTransferLog.fileId, fileIds),
        eq(netdriveTransferLog.direction, "mirror"),
        isNotNull(netdriveTransferLog.siteId),
      ),
    );
  const sites: string[] = [];
  for (const r of rows) {
    if (r.siteId) sites.push(r.siteId);
  }
  return sites;
}
