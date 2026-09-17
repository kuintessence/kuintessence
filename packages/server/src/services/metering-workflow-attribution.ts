import {
  netdriveFiles,
  netdriveTransferLog,
  type PgDb,
  userOrgMemberships,
  workflowRuns,
} from "@kuintessence/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantScope } from "./metering";

export interface WorkflowNetDriveAttribution {
  workflowRunId: string;
  workflowName: string;
  orgId: string | null;
  transferCount: number;
  totalTransferBytes: number;
  networkEgressBytes: number;
  storageBytes: number;
  byDirection: {
    upload: number;
    download: number;
    mirror: number;
  };
  netdriveFileIds: string[];
}

export interface WorkflowNetDriveAttributionReader {
  getWorkflowNetDriveAttribution(
    workflowRunId: string,
    scope: TenantScope,
  ): Promise<WorkflowNetDriveAttribution | null>;
}

export class MeteringWorkflowAttributionService implements WorkflowNetDriveAttributionReader {
  constructor(private readonly db: PgDb) {}

  async getWorkflowNetDriveAttribution(
    workflowRunId: string,
    scope: TenantScope,
  ): Promise<WorkflowNetDriveAttribution | null> {
    const [run] = await this.db
      .select({
        id: workflowRuns.id,
        name: workflowRuns.name,
        orgId: userOrgMemberships.orgId,
      })
      .from(workflowRuns)
      .leftJoin(userOrgMemberships, eq(workflowRuns.submittedBy, userOrgMemberships.userId))
      .where(eq(workflowRuns.id, workflowRunId))
      .orderBy(asc(userOrgMemberships.createdAt))
      .limit(1);
    if (!run || !isRunVisible(run.orgId, scope)) return null;

    const directionRows = await this.db
      .select({
        direction: netdriveTransferLog.direction,
        bytes: sql<string>`coalesce(sum(${netdriveTransferLog.bytes}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(netdriveTransferLog)
      .where(transferScopeFilter(workflowRunId, scope))
      .groupBy(netdriveTransferLog.direction);

    const byDirection = { upload: 0, download: 0, mirror: 0 };
    let transferCount = 0;
    for (const row of directionRows) {
      if (
        row.direction === "upload" ||
        row.direction === "download" ||
        row.direction === "mirror"
      ) {
        byDirection[row.direction] = numericStringToNumber(row.bytes);
      }
      transferCount += numericStringToNumber(row.count);
    }

    const fileIdRows = await this.db
      .select({
        fileId: netdriveTransferLog.fileId,
        netdriveFileIds: netdriveTransferLog.netdriveFileIds,
      })
      .from(netdriveTransferLog)
      .where(transferScopeFilter(workflowRunId, scope));
    const netdriveFileIds = [
      ...new Set(
        fileIdRows.flatMap((row) => [...(row.fileId ? [row.fileId] : []), ...row.netdriveFileIds]),
      ),
    ].sort();

    const [storageRow] =
      netdriveFileIds.length > 0
        ? await this.db
            .select({ bytes: sql<string>`coalesce(sum(${netdriveFiles.size}), 0)` })
            .from(netdriveFiles)
            .where(inArray(netdriveFiles.id, netdriveFileIds))
        : [{ bytes: "0" }];

    return {
      workflowRunId: run.id,
      workflowName: run.name,
      orgId: run.orgId,
      transferCount,
      totalTransferBytes: byDirection.upload + byDirection.download + byDirection.mirror,
      networkEgressBytes: byDirection.download + byDirection.mirror,
      storageBytes: numericStringToNumber(storageRow?.bytes ?? "0"),
      byDirection,
      netdriveFileIds,
    };
  }
}

function isRunVisible(orgId: string | null, scope: TenantScope): boolean {
  if (scope.kind === "all") return true;
  if (!orgId) return false;
  return scope.orgIds.includes(orgId);
}

function transferScopeFilter(workflowRunId: string, scope: TenantScope) {
  const byRun = eq(netdriveTransferLog.workflowRunId, workflowRunId);
  if (scope.kind === "all") return byRun;
  if (scope.orgIds.length === 0) {
    return and(byRun, sql`false`);
  }
  return and(byRun, inArray(netdriveTransferLog.orgId, scope.orgIds));
}

function numericStringToNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`metering workflow attribution produced non-finite numeric value: ${value}`);
  }
  return n;
}
