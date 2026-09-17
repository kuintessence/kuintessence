import { type PgDb, sandboxPolicyOverlays } from "@kuintessence/db";
import {
  type EffectiveSandboxPolicy,
  type SandboxPolicyOverlay,
  SandboxPolicyOverlaySchema,
  tightenSandboxPolicy,
} from "@kuintessence/shared";
import { and, eq, isNull } from "drizzle-orm";

export interface SandboxPolicyTarget {
  providerOrgId: string | null;
  clusterId: string | null;
  agentId: string | null;
}

export class SandboxPolicyService {
  constructor(
    private readonly db: PgDb,
    private readonly platformMaximum: EffectiveSandboxPolicy,
  ) {}

  async effectiveFor(target: SandboxPolicyTarget): Promise<EffectiveSandboxPolicy> {
    const rows = await this.db.select().from(sandboxPolicyOverlays);
    const overlays: SandboxPolicyOverlay[] = [];
    const platform = rows.find(
      (row) =>
        row.scope === "platform" &&
        row.providerOrgId === null &&
        row.clusterId === null &&
        row.agentId === null,
    );
    if (platform) overlays.push(SandboxPolicyOverlaySchema.parse(platform.policy));
    if (target.providerOrgId) {
      const provider = rows.find(
        (row) =>
          row.scope === "provider" &&
          row.providerOrgId === target.providerOrgId &&
          row.clusterId === null &&
          row.agentId === null,
      );
      if (provider) overlays.push(SandboxPolicyOverlaySchema.parse(provider.policy));
    }
    if (target.providerOrgId && target.clusterId) {
      const cluster = rows.find(
        (row) =>
          row.scope === "cluster" &&
          row.providerOrgId === target.providerOrgId &&
          row.clusterId === target.clusterId &&
          row.agentId === null,
      );
      if (cluster) overlays.push(SandboxPolicyOverlaySchema.parse(cluster.policy));
    }
    if (target.agentId) {
      const agent = rows.find((row) => row.scope === "agent" && row.agentId === target.agentId);
      if (agent) overlays.push(SandboxPolicyOverlaySchema.parse(agent.policy));
    }
    return tightenSandboxPolicy(this.platformMaximum, overlays);
  }

  async upsert(input: {
    scope: "platform" | "provider" | "cluster" | "agent";
    providerOrgId?: string;
    clusterId?: string;
    agentId?: string;
    policy: SandboxPolicyOverlay;
    updatedBy: string;
  }) {
    const policy = SandboxPolicyOverlaySchema.parse(input.policy);
    const scopeConditions = [eq(sandboxPolicyOverlays.scope, input.scope)];
    scopeConditions.push(
      input.providerOrgId
        ? eq(sandboxPolicyOverlays.providerOrgId, input.providerOrgId)
        : isNull(sandboxPolicyOverlays.providerOrgId),
      input.clusterId
        ? eq(sandboxPolicyOverlays.clusterId, input.clusterId)
        : isNull(sandboxPolicyOverlays.clusterId),
      input.agentId
        ? eq(sandboxPolicyOverlays.agentId, input.agentId)
        : isNull(sandboxPolicyOverlays.agentId),
    );
    const [existing] = await this.db
      .select({ id: sandboxPolicyOverlays.id })
      .from(sandboxPolicyOverlays)
      .where(and(...scopeConditions))
      .limit(1);
    if (existing) {
      const [updated] = await this.db
        .update(sandboxPolicyOverlays)
        .set({ policy, updatedBy: input.updatedBy, updatedAt: new Date() })
        .where(eq(sandboxPolicyOverlays.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await this.db
      .insert(sandboxPolicyOverlays)
      .values({
        scope: input.scope,
        providerOrgId: input.providerOrgId ?? null,
        clusterId: input.clusterId ?? null,
        agentId: input.agentId ?? null,
        policy,
        updatedBy: input.updatedBy,
      })
      .returning();
    return created;
  }
}
