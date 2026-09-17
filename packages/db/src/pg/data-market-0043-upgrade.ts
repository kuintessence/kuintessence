import { eq, isNull, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { dataReplicas, jobDataBindings } from "./schema";

export interface DataMarketBindingForStagePath {
  id: string;
  jobId: string;
  inputDescriptor: string;
}

export interface DataMarket0043UpgradePort {
  markAvailableReplicasStale(): Promise<number>;
  listBindingsForStagePathPreflight(): Promise<readonly DataMarketBindingForStagePath[]>;
  listBindingsMissingStagePath(): Promise<readonly DataMarketBindingForStagePath[]>;
  setStagePaths(bindings: readonly { id: string; stagePath: string }[]): Promise<void>;
}

export class PgDataMarket0043UpgradePort implements DataMarket0043UpgradePort {
  constructor(private readonly db: PgDb) {}

  async markAvailableReplicasStale(): Promise<number> {
    const result = await this.db.execute(
      sql`UPDATE ${dataReplicas} SET status = 'stale', updated_at = NOW() WHERE status = 'available'`,
    );
    return result.count;
  }

  async listBindingsForStagePathPreflight(): Promise<readonly DataMarketBindingForStagePath[]> {
    return this.db
      .select({
        id: jobDataBindings.id,
        jobId: jobDataBindings.jobId,
        inputDescriptor: jobDataBindings.inputDescriptor,
      })
      .from(jobDataBindings);
  }

  async listBindingsMissingStagePath(): Promise<readonly DataMarketBindingForStagePath[]> {
    return this.db
      .select({
        id: jobDataBindings.id,
        jobId: jobDataBindings.jobId,
        inputDescriptor: jobDataBindings.inputDescriptor,
      })
      .from(jobDataBindings)
      .where(isNull(jobDataBindings.stagePath));
  }

  async setStagePaths(bindings: readonly { id: string; stagePath: string }[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await Promise.all(
        bindings.map((binding) =>
          tx
            .update(jobDataBindings)
            .set({ stagePath: binding.stagePath })
            .where(eq(jobDataBindings.id, binding.id)),
        ),
      );
    });
  }
}

export interface DataMarket0043PreflightResult {
  ready: boolean;
  staleReplicaCount: number;
  blockers: Array<{ jobId: string; inputDescriptor: string; reason: string }>;
  stagePathBindings: Array<{ id: string; stagePath: string }>;
}

export async function preflightDataMarket0043Upgrade(
  port: DataMarket0043UpgradePort,
): Promise<DataMarket0043PreflightResult> {
  const bindings = await port.listBindingsForStagePathPreflight();
  const plan = planStagePathBackfill(bindings);
  if (plan.blockers.length > 0) {
    return {
      ready: false,
      staleReplicaCount: 0,
      blockers: plan.blockers,
      stagePathBindings: [],
    };
  }
  const staleReplicaCount = await port.markAvailableReplicasStale();
  return {
    ready: true,
    staleReplicaCount,
    blockers: [],
    stagePathBindings: plan.bindings,
  };
}

export async function backfillDataMarket0043StagePaths(
  port: DataMarket0043UpgradePort,
): Promise<void> {
  const plan = planStagePathBackfill(await port.listBindingsMissingStagePath());
  if (plan.blockers.length > 0) {
    throw new Error("Data Market 0043 stage-path backfill is unsafe; resolve preflight blockers");
  }
  await port.setStagePaths(plan.bindings);
}

export async function applyDataMarket0043StagePathBackfill(
  port: Pick<DataMarket0043UpgradePort, "setStagePaths">,
  bindings: readonly { id: string; stagePath: string }[],
): Promise<void> {
  await port.setStagePaths(bindings);
}

export function planStagePathBackfill(bindings: readonly DataMarketBindingForStagePath[]): {
  bindings: Array<{ id: string; stagePath: string }>;
  blockers: Array<{ jobId: string; inputDescriptor: string; reason: string }>;
} {
  const planned: Array<{ id: string; jobId: string; inputDescriptor: string; stagePath: string }> =
    [];
  const blockers: Array<{ jobId: string; inputDescriptor: string; reason: string }> = [];
  for (const binding of bindings) {
    const normalized = normalizeInputDescriptor(binding.inputDescriptor);
    if (!normalized) {
      blockers.push({
        jobId: binding.jobId,
        inputDescriptor: binding.inputDescriptor,
        reason: "input_descriptor cannot produce a canonical stage path",
      });
      continue;
    }
    planned.push({
      id: binding.id,
      jobId: binding.jobId,
      inputDescriptor: binding.inputDescriptor,
      stagePath: `inputs/${normalized}`,
    });
  }
  const targets = new Map<string, typeof planned>();
  for (const binding of planned) {
    const key = `${binding.jobId}:${binding.stagePath}`;
    const matching = targets.get(key) ?? [];
    matching.push(binding);
    targets.set(key, matching);
  }
  for (const matching of targets.values()) {
    if (matching.length < 2) continue;
    for (const binding of matching) {
      blockers.push({
        jobId: binding.jobId,
        inputDescriptor: binding.inputDescriptor,
        reason: `normalizes to a duplicate stage path: ${binding.stagePath}`,
      });
    }
  }
  return {
    bindings: planned.map(({ id, stagePath }) => ({ id, stagePath })),
    blockers,
  };
}

export function normalizeInputDescriptor(inputDescriptor: string): string | null {
  const normalized = inputDescriptor
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return normalized.length > 0 ? normalized : null;
}
