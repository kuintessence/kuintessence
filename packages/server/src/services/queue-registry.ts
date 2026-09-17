import { type PgDb, schedulerQueues } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  type PlacementPreferenceRejection,
  type QueueAvailabilityReason,
  type QueueRegistryCreate,
  type QueueRegistryUpdate,
  type QueueRegistryView,
  type QueueSubmitEligibility,
  type QueueTarget,
  type QueueTargetMode,
  type QueueValidationMode,
  type RoleName,
  resolveQueueTargetMode,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { queuePlatformTuple, queueProviderTuple, queueVisibleOrgTuple } from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";
import {
  type AgentQueueInventory,
  isHpcScheduler,
  type QueueInventoryService,
  type QueueTargetAvailability,
  queueInventoryUnavailable,
  queueUnavailable,
} from "./queue-inventory";

export interface QueueAccessContext {
  role: RoleName;
  orgId: string | null;
  orgIds?: string[];
  userId?: string | null;
  email?: string | null;
  sub?: string | null;
}

export interface QueueSelection {
  queueId: string;
  agentId: string;
  schedulerType: string;
  targetMode?: QueueTargetMode;
  queueName?: string;
  resolvedQueueName?: string;
  queueObservedAt?: Date;
  validationMode?: QueueValidationMode;
  qos: string | null;
  policyTags: string[];
}

export interface QueueDispatchTarget {
  targetMode: QueueTargetMode;
  queueName?: string;
  resolvedQueueName?: string;
  queueObservedAt?: Date;
  validationMode: QueueValidationMode;
  qos: string | null;
}

export interface PreferredQueueResolution {
  selections: QueueSelection[];
  rejections: PlacementPreferenceRejection[];
}

type QueueRow = typeof schedulerQueues.$inferSelect;

export interface QueueRegistryOptions {
  inventory?: QueueInventoryService;
  validationMode?: QueueValidationMode;
}

export interface QueueInventoryAdminView extends AgentQueueInventory {
  queues: Array<
    AgentQueueInventory["queues"][number] & {
      managed: boolean;
      managedQueueIds: string[];
    }
  >;
  managedTargets: Array<{
    queueId: string;
    targetMode: QueueTargetMode;
    queueName: string | null;
    available: boolean;
    reason: QueueAvailabilityReason | null;
  }>;
}

function isPlatformWide(role: RoleName): boolean {
  return hasRole(role, "platform_admin");
}

function isVisible(row: QueueRow, ctx: QueueAccessContext): boolean {
  if (isPlatformWide(ctx.role)) return true;
  const orgIds = contextOrgIds(ctx);
  if (orgIds.length === 0) return false;
  if (orgIds.includes(row.providerOrgId)) return true;
  return row.visibleOrgIds.some((orgId) => orgIds.includes(orgId));
}

function assertProviderManagement(rowOrProviderOrgId: QueueRow | string, ctx: QueueAccessContext) {
  if (isPlatformWide(ctx.role)) return;
  if (!hasRole(ctx.role, "org_admin")) {
    throw new AppError(ErrorCode.FORBIDDEN, "Queue management requires org_admin", 403);
  }
  const providerOrgId =
    typeof rowOrProviderOrgId === "string" ? rowOrProviderOrgId : rowOrProviderOrgId.providerOrgId;
  if (!contextOrgIds(ctx).includes(providerOrgId)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Cannot manage queues outside your provider org", 403);
  }
}

export class QueueRegistryService {
  constructor(
    private db: PgDb,
    private readonly authz?: AuthzService,
    private readonly options: QueueRegistryOptions = {},
  ) {}

  get validationMode(): QueueValidationMode {
    return this.options.validationMode ?? "off";
  }

  async create(input: QueueRegistryCreate, ctx: QueueAccessContext): Promise<QueueRegistryView> {
    const providerOrgId = input.providerOrgId ?? ctx.orgId ?? contextOrgIds(ctx)[0];
    if (!providerOrgId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "providerOrgId is required", 400);
    }
    const localAllowed = isPlatformWide(ctx.role) || contextOrgIds(ctx).includes(providerOrgId);
    if (this.authz?.mode !== "enforce") {
      assertProviderManagement(providerOrgId, ctx);
    }
    await this.assertProviderThroughSpice(providerOrgId, ctx, localAllowed);
    const target = resolveStoredQueueTarget(input);
    const boundSchedulerType = await this.assertAgentBinding({
      agentId: input.agentId,
      providerOrgId,
      schedulerType: input.schedulerType,
    });
    await this.assertEnabledTargetAvailability({
      enabled: input.enabled,
      agentId: input.agentId,
      schedulerType: input.schedulerType,
      targetMode: target.targetMode,
      queueName: target.queueName,
    });

    const now = new Date();
    const [row] = await this.db
      .insert(schedulerQueues)
      .values({
        queueId: input.queueId,
        name: input.name,
        providerOrgId,
        visibleOrgIds: input.visibleOrgIds,
        agentId: input.agentId,
        schedulerType: boundSchedulerType ?? input.schedulerType,
        targetMode: target.targetMode,
        queueName: target.queueName,
        qos: input.qos ?? null,
        enabled: input.enabled,
        policyTags: input.policyTags,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Queue insert returned no rows", 500);
    }
    await this.authz?.enqueueMany(queueTuples(row, "create"));
    return this.toView(row);
  }

  async listAdmin(ctx: QueueAccessContext): Promise<QueueRegistryView[]> {
    const rows = await this.db.select().from(schedulerQueues);
    const visible: QueueRow[] = [];
    for (const row of rows) {
      const localAllowed =
        isPlatformWide(ctx.role) || contextOrgIds(ctx).includes(row.providerOrgId);
      if (await this.filterThroughSpice(row, "manage", ctx, localAllowed)) {
        visible.push(row);
      }
    }
    return Promise.all(visible.map((row) => this.toView(row)));
  }

  async listVisible(ctx: QueueAccessContext): Promise<QueueRegistryView[]> {
    const rows = await this.db.select().from(schedulerQueues);
    const visible: QueueRow[] = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      const localAllowed = isVisible(row, ctx);
      if (await this.filterThroughSpice(row, "view", ctx, localAllowed)) {
        visible.push(row);
      }
    }
    return Promise.all(visible.map((row) => this.toView(row, ctx)));
  }

  async update(
    queueId: string,
    patch: QueueRegistryUpdate,
    ctx: QueueAccessContext,
  ): Promise<QueueRegistryView> {
    const row = await this.getRow(queueId);
    const localAllowed = isPlatformWide(ctx.role) || contextOrgIds(ctx).includes(row.providerOrgId);
    if (this.authz?.mode !== "enforce") {
      assertProviderManagement(row, ctx);
    }
    await this.assertThroughSpice(row, "manage", ctx, localAllowed);
    const target = resolveUpdatedQueueTarget(row, patch);
    const nextAgentId = patch.agentId ?? row.agentId;
    const nextSchedulerType = patch.schedulerType ?? row.schedulerType;
    const boundSchedulerType = await this.assertAgentBinding({
      agentId: nextAgentId,
      providerOrgId: row.providerOrgId,
      schedulerType: nextSchedulerType,
    });
    await this.assertEnabledTargetAvailability({
      enabled: patch.enabled ?? row.enabled,
      agentId: nextAgentId,
      schedulerType: nextSchedulerType,
      targetMode: target.targetMode,
      queueName: target.queueName,
    });
    const [updated] = await this.db
      .update(schedulerQueues)
      .set({
        name: patch.name,
        visibleOrgIds: patch.visibleOrgIds,
        agentId: nextAgentId,
        schedulerType: boundSchedulerType ?? nextSchedulerType,
        targetMode: target.targetMode,
        queueName: target.queueName,
        qos: patch.qos,
        enabled: patch.enabled,
        policyTags: patch.policyTags,
        updatedAt: new Date(),
      })
      .where(eq(schedulerQueues.queueId, queueId))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, `Queue ${queueId} not found`, 404);
    }
    await this.authz?.enqueueMany([
      ...queueTuples(row, "delete"),
      ...queueTuples(updated, "create"),
    ]);
    return this.toView(updated);
  }

  async resolveForSubmit(
    queueId: string | undefined,
    ctx: QueueAccessContext,
  ): Promise<QueueSelection | null> {
    if (!queueId) return null;
    const row = await this.getRow(queueId);
    if (!row.enabled) {
      throw queueUnavailable(`Queue ${queueId} is disabled`, "queue_disabled");
    }
    const localAllowed = isVisible(row, ctx);
    if (this.authz?.mode !== "enforce" && !localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, `Queue ${queueId} is not visible to this org`, 403);
    }
    const availability = await this.inspectAvailability(row);
    const eligibility = await this.inspectSubmitEligibility(row, ctx, availability, localAllowed);
    this.assertSubmissionEligibility(queueId, eligibility);
    return this.toSelection(row, availability);
  }

  async resolvePreferredForSubmit(
    queueIds: readonly string[] | undefined,
    ctx: QueueAccessContext,
  ): Promise<QueueSelection[]> {
    return (await this.inspectPreferredForSubmit(queueIds, ctx)).selections;
  }

  async inspectPreferredForSubmit(
    queueIds: readonly string[] | undefined,
    ctx: QueueAccessContext,
  ): Promise<PreferredQueueResolution> {
    const selections: QueueSelection[] = [];
    const rejections: PlacementPreferenceRejection[] = [];
    for (const queueId of queueIds ?? []) {
      try {
        const selection = await this.resolveForSubmit(queueId, ctx);
        if (selection) {
          selections.push(selection);
        }
      } catch (err) {
        if (err instanceof AppError && isSkippablePreferredQueueError(err)) {
          rejections.push(preferredQueueRejection(queueId, err));
          continue;
        }
        throw err;
      }
    }
    return { selections, rejections };
  }

  async getAgentInventoryForAdmin(
    agentId: string,
    ctx: QueueAccessContext,
  ): Promise<QueueInventoryAdminView> {
    const inventoryService = this.options.inventory;
    if (!inventoryService) {
      throw queueInventoryUnavailable(
        "Queue inventory service is not configured",
        "inventory_not_supported",
      );
    }
    const inventory = await inventoryService.getForAgent(agentId);
    const localAllowed =
      isPlatformWide(ctx.role) ||
      (inventory.providerOrgId !== null && contextOrgIds(ctx).includes(inventory.providerOrgId));
    if (inventory.providerOrgId === null) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent is not bound to a provider", 403);
    }
    if (this.authz?.mode !== "enforce") {
      assertProviderManagement(inventory.providerOrgId, ctx);
    }
    await this.assertProviderThroughSpice(inventory.providerOrgId, ctx, localAllowed);

    const managedTargets = await this.db
      .select({
        queueId: schedulerQueues.queueId,
        targetMode: schedulerQueues.targetMode,
        queueName: schedulerQueues.queueName,
        schedulerType: schedulerQueues.schedulerType,
      })
      .from(schedulerQueues)
      .where(eq(schedulerQueues.agentId, agentId));
    const targetAvailability = await Promise.all(
      managedTargets.map(async (target) => ({
        queueId: target.queueId,
        targetMode: targetModeForValue(target.targetMode),
        queueName: target.queueName,
        availability: await inventoryService.inspectTarget({
          agentId,
          schedulerType: target.schedulerType,
          targetMode: targetModeForValue(target.targetMode),
          ...(target.queueName ? { queueName: target.queueName } : {}),
        }),
      })),
    );
    return {
      ...inventory,
      queues: inventory.queues.map((queue) => {
        const managedQueueIds = targetAvailability
          .filter(
            (target) =>
              (target.targetMode === "default" && queue.isDefault) ||
              (target.targetMode === "named" && target.queueName === queue.queueName),
          )
          .map((target) => target.queueId);
        return { ...queue, managed: managedQueueIds.length > 0, managedQueueIds };
      }),
      managedTargets: targetAvailability.map((target) => ({
        queueId: target.queueId,
        targetMode: target.targetMode,
        queueName: target.queueName,
        available: target.availability.targetAvailable,
        reason: target.availability.reason,
      })),
    };
  }

  async autoCandidateRejection(agentId: string, schedulerType: string): Promise<string | null> {
    if (this.validationMode !== "enforce" || !isHpcScheduler(schedulerType)) return null;
    const availability = await this.inspectAutoDefault(agentId, schedulerType);
    if (!availability) return "scheduler queue inventory is unavailable: inventory_not_supported";
    if (availability.inventoryAvailable && availability.targetAvailable) return null;
    return availability.inventoryAvailable
      ? `scheduler default queue is unavailable: ${availability.reason ?? "unknown"}`
      : `scheduler queue inventory is unavailable: ${availability.reason ?? "unknown"}`;
  }

  async resolveAutoTarget(agentId: string, schedulerType: string): Promise<QueueDispatchTarget> {
    const availability = await this.inspectAutoDefault(agentId, schedulerType);
    if (this.validationMode === "enforce" && isHpcScheduler(schedulerType)) {
      this.throwForUnavailableTarget("Scheduler default queue", availability);
    }
    return {
      targetMode: "default",
      ...(availability?.resolvedQueueName
        ? { resolvedQueueName: availability.resolvedQueueName }
        : {}),
      ...(availability?.inventoryAvailable && availability.observedAt
        ? { queueObservedAt: availability.observedAt }
        : {}),
      validationMode: this.validationMode,
      qos: null,
    };
  }

  async assertDispatchTargetAvailable(input: {
    agentId: string;
    schedulerType: string;
    targetMode: QueueTargetMode;
    queueName?: string;
  }): Promise<void> {
    if (this.validationMode !== "enforce" || !isHpcScheduler(input.schedulerType)) return;
    const availability = await this.options.inventory?.inspectTarget(input);
    this.throwForUnavailableTarget("Queue dispatch target", availability ?? null);
  }

  private async toView(row: QueueRow, ctx?: QueueAccessContext): Promise<QueueRegistryView> {
    const availability = await this.inspectAvailability(row);
    const targetMode = targetModeForRow(row);
    const localAllowed = ctx ? isVisible(row, ctx) : false;
    const submitEligibility = ctx
      ? await this.inspectSubmitEligibility(row, ctx, availability, localAllowed)
      : undefined;
    return {
      queueId: row.queueId,
      name: row.name,
      providerOrgId: row.providerOrgId,
      visibleOrgIds: row.visibleOrgIds,
      agentId: row.agentId,
      schedulerType: row.schedulerType as QueueRegistryView["schedulerType"],
      queueName: row.queueName,
      target: { mode: targetMode },
      qos: row.qos,
      resolvedQueueName:
        availability?.resolvedQueueName ?? (targetMode === "named" ? row.queueName : null),
      ...(availability
        ? {
            availability: {
              state: availability.state,
              reason: availability.reason,
              observedAt: availability.observedAt?.toISOString() ?? null,
            },
          }
        : {}),
      ...(submitEligibility ? { submitEligibility } : {}),
      enabled: row.enabled,
      policyTags: row.policyTags,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSelection(row: QueueRow, availability: QueueTargetAvailability | null): QueueSelection {
    const targetMode = targetModeForRow(row);
    return {
      queueId: row.queueId,
      agentId: row.agentId,
      schedulerType: row.schedulerType,
      targetMode,
      ...(targetMode === "named" && row.queueName ? { queueName: row.queueName } : {}),
      ...(availability?.resolvedQueueName
        ? { resolvedQueueName: availability.resolvedQueueName }
        : targetMode === "named" && row.queueName
          ? { resolvedQueueName: row.queueName }
          : {}),
      ...(availability?.inventoryAvailable && availability.observedAt
        ? { queueObservedAt: availability.observedAt }
        : {}),
      validationMode: this.validationMode,
      qos: row.qos,
      policyTags: row.policyTags,
    };
  }

  private async assertAgentBinding(input: {
    agentId: string;
    providerOrgId: string;
    schedulerType: string;
  }): Promise<string | undefined> {
    const binding = await this.options.inventory?.assertAgentBinding(input);
    return binding?.schedulerType;
  }

  private async assertEnabledTargetAvailability(input: {
    enabled: boolean;
    agentId: string;
    schedulerType: string;
    targetMode: QueueTargetMode;
    queueName: string | null;
  }): Promise<void> {
    if (!input.enabled || !this.options.inventory) return;
    const availability = await this.options.inventory.inspectTarget({
      agentId: input.agentId,
      schedulerType: input.schedulerType,
      targetMode: input.targetMode,
      ...(input.queueName ? { queueName: input.queueName } : {}),
    });
    this.throwForUnavailableTarget("Queue target", availability);
  }

  private async inspectAvailability(row: QueueRow): Promise<QueueTargetAvailability | null> {
    if (!this.options.inventory) return null;
    return this.options.inventory.inspectTarget({
      agentId: row.agentId,
      schedulerType: row.schedulerType,
      targetMode: targetModeForRow(row),
      ...(row.queueName ? { queueName: row.queueName } : {}),
    });
  }

  private async inspectAutoDefault(
    agentId: string,
    schedulerType: string,
  ): Promise<QueueTargetAvailability | null> {
    if (!this.options.inventory) return null;
    return this.options.inventory.inspectTarget({
      agentId,
      schedulerType,
      targetMode: "default",
    });
  }

  private async inspectSubmitEligibility(
    row: QueueRow,
    ctx: QueueAccessContext,
    availability: QueueTargetAvailability | null,
    localAllowed: boolean,
  ): Promise<QueueSubmitEligibility> {
    if (!row.enabled) {
      return { state: "blocked", reason: "queue_disabled", retryable: false };
    }
    if (!(await this.hasSubmitPermission(row, ctx, localAllowed))) {
      return { state: "blocked", reason: "submit_permission_missing", retryable: false };
    }
    if (availability?.reason === "scheduler_mismatch") {
      return { state: "blocked", reason: "scheduler_mismatch", retryable: false };
    }
    if (!isHpcScheduler(row.schedulerType)) {
      return { state: "ready", reason: null, retryable: false };
    }
    if (availability?.inventoryAvailable && availability.targetAvailable) {
      return { state: "ready", reason: null, retryable: false };
    }
    const reason = availability?.reason ?? "inventory_not_supported";
    const retryable = !availability?.inventoryAvailable;
    if (this.validationMode !== "enforce") {
      return { state: "warning", reason, retryable };
    }
    return { state: "blocked", reason, retryable };
  }

  private assertSubmissionEligibility(queueId: string, eligibility: QueueSubmitEligibility): void {
    if (eligibility.state !== "blocked") return;
    if (eligibility.reason === "submit_permission_missing") {
      throw new AppError(ErrorCode.FORBIDDEN, `Queue ${queueId} cannot be submitted`, 403);
    }
    if (eligibility.retryable) {
      throw queueInventoryUnavailable(
        `Queue ${queueId} inventory is unavailable`,
        eligibility.reason ?? "inventory_not_supported",
      );
    }
    throw queueUnavailable(`Queue ${queueId} is unavailable`, eligibility.reason ?? "unknown");
  }

  private throwForUnavailableTarget(
    label: string,
    availability: QueueTargetAvailability | null,
  ): void {
    if (!availability?.inventoryAvailable) {
      throw queueInventoryUnavailable(
        `${label} inventory is unavailable`,
        availability?.reason ?? "inventory_not_supported",
      );
    }
    if (!availability.targetAvailable) {
      throw queueUnavailable(`${label} is unavailable`, availability.reason ?? "unknown");
    }
  }

  private async getRow(queueId: string): Promise<QueueRow> {
    const [row] = await this.db
      .select()
      .from(schedulerQueues)
      .where(eq(schedulerQueues.queueId, queueId))
      .limit(1);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, `Queue ${queueId} not found`, 404);
    }
    return row;
  }

  private async filterThroughSpice(
    row: QueueRow,
    permission: "view" | "manage",
    ctx: QueueAccessContext,
    localAllowed: boolean,
  ): Promise<boolean> {
    if (!this.authz || this.authz.mode === "off") return localAllowed;
    const check = queueCheck(row.queueId, permission, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return localAllowed;
    }
    try {
      await this.authz.requirePermission(check, isPlatformWide(ctx.role));
      return true;
    } catch {
      return false;
    }
  }

  private async assertThroughSpice(
    row: QueueRow,
    permission: "submit" | "manage",
    ctx: QueueAccessContext,
    localAllowed: boolean,
  ): Promise<void> {
    if (!this.authz || this.authz.mode === "off") return;
    const check = queueCheck(row.queueId, permission, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return;
    }
    await this.authz.requirePermission(check, isPlatformWide(ctx.role));
  }

  private async hasSubmitPermission(
    row: QueueRow,
    ctx: QueueAccessContext,
    localAllowed: boolean,
  ): Promise<boolean> {
    if (!this.authz || this.authz.mode === "off") return localAllowed;
    const check = queueCheck(row.queueId, "submit", ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return localAllowed;
    }
    try {
      await this.authz.requirePermission(check, isPlatformWide(ctx.role));
      return true;
    } catch {
      return false;
    }
  }

  private async assertProviderThroughSpice(
    providerOrgId: string,
    ctx: QueueAccessContext,
    localAllowed: boolean,
  ): Promise<void> {
    if (!this.authz || this.authz.mode === "off") return;
    const check = providerCheck(providerOrgId, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return;
    }
    await this.authz.requirePermission(check, isPlatformWide(ctx.role));
  }
}

function targetModeForRow(row: QueueRow): QueueTargetMode {
  return targetModeForValue(row.targetMode);
}

function targetModeForValue(value: string): QueueTargetMode {
  return value === "default" ? "default" : "named";
}

function resolveStoredQueueTarget(input: { target?: QueueTarget; queueName?: string }): {
  targetMode: QueueTargetMode;
  queueName: string | null;
} {
  const targetMode = resolveQueueTargetMode(input);
  if (targetMode === "default") {
    if (input.queueName !== undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Default queue target cannot include queueName",
        400,
      );
    }
    return { targetMode, queueName: null };
  }
  if (!input.queueName) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Named queue target requires queueName", 400);
  }
  return { targetMode, queueName: input.queueName };
}

function resolveUpdatedQueueTarget(
  row: QueueRow,
  patch: QueueRegistryUpdate,
): { targetMode: QueueTargetMode; queueName: string | null } {
  if (patch.target?.mode === "default") {
    return resolveStoredQueueTarget(patch);
  }
  if (patch.target?.mode === "named") {
    return resolveStoredQueueTarget(patch);
  }
  const targetMode = targetModeForRow(row);
  if (targetMode === "default") {
    if (patch.queueName !== undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Set target.mode to named before assigning queueName",
        400,
      );
    }
    return { targetMode, queueName: null };
  }
  return resolveStoredQueueTarget({
    target: { mode: "named" },
    queueName: patch.queueName ?? row.queueName ?? undefined,
  });
}

function contextOrgIds(ctx: QueueAccessContext): string[] {
  return [...new Set(ctx.orgIds ?? (ctx.orgId ? [ctx.orgId] : []))];
}

function isSkippablePreferredQueueError(error: AppError): boolean {
  return (
    error.code === ErrorCode.NOT_FOUND ||
    error.code === ErrorCode.FORBIDDEN ||
    error.code === ErrorCode.QUEUE_UNAVAILABLE ||
    error.code === ErrorCode.QUEUE_INVENTORY_UNAVAILABLE
  );
}

function preferredQueueRejection(queueId: string, error: AppError): PlacementPreferenceRejection {
  return {
    queueId,
    code: error.code,
    reason: queueErrorReason(error) ?? fallbackPreferredQueueReason(error.code),
  };
}

function queueErrorReason(error: AppError): string | undefined {
  if (!error.details || typeof error.details !== "object") return undefined;
  const reason = (error.details as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

function fallbackPreferredQueueReason(code: string): string {
  if (code === ErrorCode.NOT_FOUND) return "queue_not_found";
  if (code === ErrorCode.FORBIDDEN) return "queue_not_visible";
  return code.toLowerCase();
}

function queueCheck(
  queueId: string,
  permission: "view" | "submit" | "manage",
  ctx: QueueAccessContext,
  localAllowed: boolean,
) {
  const subjectId = subjectIdForQueueAuthz(ctx);
  return {
    actorUserId: ctx.userId ?? null,
    actorEmail: ctx.email ?? null,
    resource: { type: "queue", id: queueId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed },
    localAllowed,
  };
}

function providerCheck(providerOrgId: string, ctx: QueueAccessContext, localAllowed: boolean) {
  const subjectId = subjectIdForQueueAuthz(ctx);
  return {
    actorUserId: ctx.userId ?? null,
    actorEmail: ctx.email ?? null,
    resource: { type: "provider", id: providerOrgId },
    permission: "manage",
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source: "queue-create" },
    localAllowed,
  };
}

function subjectIdForQueueAuthz(ctx: QueueAccessContext): string {
  if (ctx.userId) return ctx.userId;
  throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
}

function queueTuples(row: QueueRow, operation: "create" | "delete"): AuthzTuple[] {
  return [
    {
      ...queueProviderTuple({ queueId: row.queueId, providerOrgId: row.providerOrgId }),
      operation,
    },
    { ...queuePlatformTuple(row.queueId), operation },
    ...row.visibleOrgIds.map((orgId) => ({
      ...queueVisibleOrgTuple({ queueId: row.queueId, orgId }),
      operation,
    })),
  ];
}
