import {
  agents,
  type PgDb,
  softwareOperations,
  softwarePolicies,
  softwarePolicyOverlays,
} from "@kuintessence/db";
import {
  SoftwareOperationAction as ProtoSoftwareOperationAction,
  type SoftwareOperationResult,
  SoftwareOperationStatus,
} from "@kuintessence/proto";
import { AppError, decideSpackPolicy, ErrorCode, type SpackPolicy } from "@kuintessence/shared";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { CpScope } from "../middleware/cp-rbac";
import type { InstalledRegistry } from "./installed-registry";
import type { SpackInstallPreparation, SpackInstallTicket } from "./spack-material-delivery";

export type SoftwareOperationAction = "install" | "uninstall" | "load" | "import_preinstalled";
export type SoftwareOperationStatusValue =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected";

export interface SoftwareOperationView {
  id: string;
  agentId: string;
  requestedBy: string | null;
  action: SoftwareOperationAction;
  spec: string;
  status: SoftwareOperationStatusValue;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export class SoftwareOperationService {
  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: AgentDispatcher,
    private readonly installedRegistry: InstalledRegistry,
    private readonly prepareSpackInstall?: (
      input: SpackInstallPreparation,
    ) => Promise<SpackInstallTicket>,
  ) {}

  async requestOperation(input: {
    scope: CpScope;
    agentId: string;
    action: SoftwareOperationAction;
    spec: string;
    requestedBy: string;
    idempotencyKey?: string;
    idempotencyItemIndex?: number;
    idempotencyItemCount?: number;
    agentScopeVerified?: boolean;
  }): Promise<SoftwareOperationView> {
    const spec = normalizeSoftwareOperationSpec(input.spec);
    const action = normalizeSoftwareOperationAction(input.action);
    const idempotency = normalizeSoftwareOperationIdempotency(input);
    if (input.agentScopeVerified) {
      await this.assertAgentExists(input.agentId);
    } else {
      await this.assertAgentInScope(input.scope, input.agentId);
    }
    const [created] = await this.db
      .insert(softwareOperations)
      .values({
        agentId: input.agentId,
        requestedBy: input.requestedBy,
        ...idempotency,
        action,
        spec,
      })
      .onConflictDoNothing({
        target: [
          softwareOperations.requestedBy,
          softwareOperations.idempotencyKey,
          softwareOperations.idempotencyItemIndex,
        ],
      })
      .returning();
    if (!created && idempotency.idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(softwareOperations)
        .where(
          and(
            eq(softwareOperations.requestedBy, input.requestedBy),
            eq(softwareOperations.idempotencyKey, idempotency.idempotencyKey),
            eq(softwareOperations.idempotencyItemIndex, idempotency.idempotencyItemIndex ?? 0),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          "Software operation idempotency lookup failed",
          500,
        );
      }
      assertIdempotentOperationMatches(existing, {
        agentId: input.agentId,
        action,
        spec,
        itemCount: idempotency.idempotencyItemCount ?? 1,
      });
      return rowToView(existing);
    }
    if (!created) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Software operation insert failed", 500);
    }
    let policyRejection: string | null;
    try {
      policyRejection = await this.policyRejection(input.agentId, action, spec);
    } catch (err) {
      const [updated] = await this.db
        .update(softwareOperations)
        .set({
          status: "failed",
          error: softwareOperationFailureMessage("software policy precheck failed", err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(softwareOperations.id, created.id))
        .returning();
      if (updated) {
        return rowToView(updated);
      }
      throw err;
    }
    if (policyRejection) {
      const [updated] = await this.db
        .update(softwareOperations)
        .set({
          status: "rejected",
          error: policyRejection,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(softwareOperations.id, created.id))
        .returning();
      return rowToView(updated ?? created);
    }
    let materialTicket: SpackInstallTicket | undefined;
    if (action === "install" && this.prepareSpackInstall) {
      try {
        materialTicket = await this.prepareSpackInstall({
          operationId: created.id,
          agentId: input.agentId,
          requestedBy: input.requestedBy,
          spec,
        });
      } catch (error) {
        const [updated] = await this.db
          .update(softwareOperations)
          .set({
            status: "rejected",
            error:
              error instanceof AppError
                ? error.message
                : "Spack material preparation failed; no install was dispatched",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(softwareOperations.id, created.id))
          .returning();
        return rowToView(updated ?? created);
      }
    }
    const dispatch = pushSoftwareOperationSafely(this.dispatcher, input.agentId, {
      operationId: created.id,
      action: actionToProto(action),
      spec,
      requestedBy: input.requestedBy,
      ...materialTicket,
    });
    if (dispatch.pushed) {
      return rowToView(created);
    }
    const [updated] = await this.db
      .update(softwareOperations)
      .set({
        status: "failed",
        error: dispatch.error ?? "agent is offline",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(softwareOperations.id, created.id))
      .returning();
    return rowToView(updated ?? created);
  }

  async listOperations(input: {
    scope: CpScope;
    agentId?: string;
    action?: SoftwareOperationAction;
    status?: SoftwareOperationStatusValue;
    limit?: number;
    agentScopeVerified?: boolean;
  }): Promise<SoftwareOperationView[]> {
    const agentIds = input.agentId ? [input.agentId] : await this.accessibleAgentIds(input.scope);
    if (agentIds.length === 0) return [];
    if (input.agentId) {
      if (input.agentScopeVerified) {
        await this.assertAgentExists(input.agentId);
      } else {
        await this.assertAgentInScope(input.scope, input.agentId);
      }
    }
    let where = inArray(softwareOperations.agentId, agentIds);
    if (input.action) {
      where = and(where, eq(softwareOperations.action, input.action)) ?? where;
    }
    if (input.status) {
      where = and(where, eq(softwareOperations.status, input.status)) ?? where;
    }
    const rows = await this.db
      .select()
      .from(softwareOperations)
      .where(where)
      .orderBy(
        desc(softwareOperations.requestedAt),
        desc(softwareOperations.updatedAt),
        desc(softwareOperations.id),
      )
      .limit(input.limit ?? 100);
    return rows.map(rowToView);
  }

  async applyAgentResult(agentId: string, result: SoftwareOperationResult): Promise<void> {
    const status = statusFromProto(result.status);
    const action = softwareOperationActionFromProto(result.action);
    if (!action) return;
    const now = new Date();
    const values = {
      status,
      stdout: result.stdout || null,
      stderr: result.stderr || null,
      exitCode: exitCodeFromResult(status, result.exitCode),
      error: result.error || null,
      ...(status === "running" ? { startedAt: now } : {}),
      ...(status === "succeeded" || status === "failed" || status === "rejected"
        ? { finishedAt: now }
        : {}),
      updatedAt: now,
    };
    const updated = await this.db
      .update(softwareOperations)
      .set(values)
      .where(
        and(
          eq(softwareOperations.id, result.operationId),
          eq(softwareOperations.agentId, agentId),
          eq(softwareOperations.action, action),
          inArray(softwareOperations.status, allowedCurrentStatusesForIncomingResult(status)),
        ),
      )
      .returning({ id: softwareOperations.id, action: softwareOperations.action });
    if (shouldRefreshInstalledLedger(status, action, updated.length > 0)) {
      try {
        await this.installedRegistry.replaceForAgent(
          agentId,
          result.installed.map((s) => ({
            name: s.name,
            version: s.version,
            hash: s.hash,
            compiler: s.compiler || undefined,
            arch: s.arch || undefined,
            spec: s.spec,
          })),
        );
      } catch (err) {
        await this.db
          .update(softwareOperations)
          .set({
            status: "failed",
            error: installedLedgerRefreshFailureMessage(err),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(softwareOperations.id, result.operationId));
      }
    }
  }

  async assertAgentInScope(scope: CpScope, agentId: string): Promise<void> {
    const agent = await this.assertAgentExists(agentId);
    if (
      !scope.isPlatformWide &&
      (agent.providerOrgId === null || !scope.orgIds.includes(agent.providerOrgId))
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
    }
  }

  async assertAgentExists(agentId: string): Promise<typeof agents.$inferSelect> {
    const [agent] = await this.db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    return agent;
  }

  private async accessibleAgentIds(scope: CpScope): Promise<string[]> {
    if (scope.isPlatformWide) {
      const rows = await this.db.select({ agentId: agents.agentId }).from(agents);
      return rows.map((row) => row.agentId);
    }
    if (scope.orgIds.length === 0) return [];
    const rows = await this.db
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(inArray(agents.providerOrgId, scope.orgIds));
    return rows.map((row) => row.agentId);
  }

  private async policyRejection(
    agentId: string,
    action: SoftwareOperationAction,
    spec: string,
  ): Promise<string | null> {
    const policy = await resolveEffectiveSpackPolicy(this.db, agentId);
    return policyRejectionForSoftwareOperation(action, spec, policy);
  }
}

export function softwareOperationActionFromProto(
  action: ProtoSoftwareOperationAction,
): SoftwareOperationAction | null {
  switch (action) {
    case ProtoSoftwareOperationAction.INSTALL:
      return "install";
    case ProtoSoftwareOperationAction.UNINSTALL:
      return "uninstall";
    case ProtoSoftwareOperationAction.LOAD:
      return "load";
    case ProtoSoftwareOperationAction.IMPORT_PREINSTALLED:
      return "import_preinstalled";
    default:
      return null;
  }
}

export function normalizeSoftwareOperationSpec(spec: string): string {
  const normalized = spec.trim();
  if (normalized.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Software operation spec is required", 400);
  }
  return normalized;
}

export function normalizeSoftwareOperationAction(action: string): SoftwareOperationAction {
  if (
    action === "install" ||
    action === "uninstall" ||
    action === "load" ||
    action === "import_preinstalled"
  ) {
    return action;
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, "Unsupported software operation action", 400);
}

export function softwareOperationFailureMessage(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${message}`;
}

export function installedLedgerRefreshFailureMessage(err: unknown): string {
  return softwareOperationFailureMessage("server installed ledger refresh failed", err);
}

function actionToProto(action: SoftwareOperationAction): ProtoSoftwareOperationAction {
  switch (action) {
    case "install":
      return ProtoSoftwareOperationAction.INSTALL;
    case "uninstall":
      return ProtoSoftwareOperationAction.UNINSTALL;
    case "load":
      return ProtoSoftwareOperationAction.LOAD;
    case "import_preinstalled":
      return ProtoSoftwareOperationAction.IMPORT_PREINSTALLED;
  }
}

function statusFromProto(status: SoftwareOperationStatus): SoftwareOperationStatusValue {
  switch (status) {
    case SoftwareOperationStatus.RUNNING:
      return "running";
    case SoftwareOperationStatus.SUCCEEDED:
      return "succeeded";
    case SoftwareOperationStatus.FAILED:
      return "failed";
    case SoftwareOperationStatus.REJECTED:
      return "rejected";
    default:
      return "failed";
  }
}

export function exitCodeFromResult(
  status: SoftwareOperationStatusValue,
  exitCode: number,
): number | null {
  if (status === "succeeded") return 0;
  if (status === "failed") return exitCode === 0 ? null : exitCode;
  return null;
}

export function shouldRefreshInstalledLedger(
  status: SoftwareOperationStatusValue,
  action: SoftwareOperationAction,
  operationMatched: boolean,
): boolean {
  return operationMatched && status === "succeeded" && action !== "load";
}

export function shouldApplyOperationResult(
  current: SoftwareOperationStatusValue,
  incoming: SoftwareOperationStatusValue,
): boolean {
  return allowedCurrentStatusesForIncomingResult(incoming).includes(current);
}

export function allowedCurrentStatusesForIncomingResult(
  incoming: SoftwareOperationStatusValue,
): SoftwareOperationStatusValue[] {
  if (incoming === "running") return ["queued"];
  return ["queued", "running"];
}

export function pushSoftwareOperationSafely(
  dispatcher: Pick<AgentDispatcher, "pushSoftwareOperation">,
  agentId: string,
  payload: {
    operationId: string;
    action: ProtoSoftwareOperationAction;
    spec: string;
    requestedBy: string;
    spackMaterialTicket?: string;
    spackManifestDigest?: string;
  },
): { pushed: boolean; error?: string } {
  try {
    return dispatcher.pushSoftwareOperation(agentId, payload)
      ? { pushed: true }
      : { pushed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pushed: false, error: `agent dispatch failed: ${message}` };
  }
}

export function policyRejectionForSoftwareOperation(
  action: SoftwareOperationAction,
  spec: string,
  policy: SpackPolicy,
): string | null {
  if (action === "import_preinstalled") return null;
  const decision = decideSpackPolicy(spec, policy);
  return decision === "allow" ? null : decision.reject;
}

interface SpackPolicyLayer {
  lockEnabled?: boolean;
  allowList?: string[] | null;
  denyList?: string[] | null;
}

export function mergeEffectiveSpackPolicyLayers(input: {
  provider?: SpackPolicyLayer | null;
  cluster?: SpackPolicyLayer | null;
  legacy?: SpackPolicyLayer | null;
  agentOverlay?: SpackPolicyLayer | null;
}): SpackPolicy {
  return {
    lockEnabled:
      (input.provider?.lockEnabled ?? false) ||
      (input.cluster?.lockEnabled ?? false) ||
      (input.legacy?.lockEnabled ?? false) ||
      (input.agentOverlay?.lockEnabled ?? false),
    allowList: uniqueSorted([
      ...(input.provider?.allowList ?? []),
      ...(input.cluster?.allowList ?? []),
      ...(input.legacy?.allowList ?? []),
      ...(input.agentOverlay?.allowList ?? []),
    ]),
    denyList: uniqueSorted([
      ...(input.provider?.denyList ?? []),
      ...(input.cluster?.denyList ?? []),
      ...(input.legacy?.denyList ?? []),
      ...(input.agentOverlay?.denyList ?? []),
    ]),
  };
}

export async function resolveEffectiveSpackPolicy(db: PgDb, agentId: string): Promise<SpackPolicy> {
  const [agent] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
  if (!agent) return { lockEnabled: false };
  const clusterId = agent.clusterId ?? agent.siteName;
  const providerCondition = agent.providerOrgId
    ? eq(softwarePolicyOverlays.providerOrgId, agent.providerOrgId)
    : isNull(softwarePolicyOverlays.providerOrgId);
  const [overlays, legacyPolicies] = await Promise.all([
    db
      .select()
      .from(softwarePolicyOverlays)
      .where(or(providerCondition, eq(softwarePolicyOverlays.agentId, agentId))),
    db.select().from(softwarePolicies).where(eq(softwarePolicies.agentId, agentId)),
  ]);
  const provider = overlays.find(
    (overlay) => overlay.scope === "provider" && overlay.providerOrgId === agent.providerOrgId,
  );
  const cluster = overlays.find(
    (overlay) =>
      overlay.scope === "cluster" &&
      overlay.providerOrgId === agent.providerOrgId &&
      overlay.clusterId === clusterId,
  );
  const agentOverlay = overlays.find(
    (overlay) => overlay.scope === "agent" && overlay.agentId === agentId,
  );
  const legacy = legacyPolicies.find((policy) => policy.scope === "agent");
  return mergeEffectiveSpackPolicyLayers({ provider, cluster, legacy, agentOverlay });
}

function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function normalizeSoftwareOperationIdempotency(input: {
  idempotencyKey?: string;
  idempotencyItemIndex?: number;
  idempotencyItemCount?: number;
}): {
  idempotencyKey?: string;
  idempotencyItemIndex?: number;
  idempotencyItemCount?: number;
} {
  if (!input.idempotencyKey) return {};
  const itemIndex = input.idempotencyItemIndex ?? 0;
  const itemCount = input.idempotencyItemCount ?? 1;
  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid software operation idempotency item",
      400,
    );
  }
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemIndex >= itemCount) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid software operation idempotency batch",
      400,
    );
  }
  return {
    idempotencyKey: input.idempotencyKey,
    idempotencyItemIndex: itemIndex,
    idempotencyItemCount: itemCount,
  };
}

function assertIdempotentOperationMatches(
  existing: typeof softwareOperations.$inferSelect,
  input: {
    agentId: string;
    action: SoftwareOperationAction;
    spec: string;
    itemCount: number;
  },
): void {
  if (
    existing.agentId !== input.agentId ||
    existing.action !== input.action ||
    existing.spec !== input.spec ||
    existing.idempotencyItemCount !== input.itemCount
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Idempotency-Key was already used for a different software operation",
      409,
    );
  }
}

function rowToView(row: typeof softwareOperations.$inferSelect): SoftwareOperationView {
  return {
    id: row.id,
    agentId: row.agentId,
    requestedBy: row.requestedBy,
    action: row.action as SoftwareOperationAction,
    spec: row.spec,
    status: row.status as SoftwareOperationStatusValue,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exitCode,
    error: row.error,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
