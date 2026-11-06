import { createHash } from "node:crypto";
import { type SqliteDb, softwareExecutions } from "@kuintessence/db";
import { SoftwareOperationAction, SoftwareOperationStatus } from "@kuintessence/proto";
import { InstalledSpecSchema } from "@kuintessence/shared";
import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  type ExecutionIdentity,
  ExecutionIdentitySchema,
  executionIdentity,
  executionState,
  INTERRUPTED,
  RECOVERY_REQUIRED,
} from "../spack/execution-identity";
import { SpackInstallStore } from "../spack/install-store";
import type { OutboundItem } from "./outbound-queue";

export type SoftwareResult = Omit<
  Extract<OutboundItem, { kind: "softwareOperationResult" }>,
  "kind"
>;
const ResultSchema = z.object({
  operationId: z.string(),
  action: z.enum(SoftwareOperationAction),
  status: z.enum(SoftwareOperationStatus),
  spec: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().optional(),
  installed: z.array(InstalledSpecSchema).optional(),
});

export class SoftwareOperationIntentConflict extends Error {}

export class SoftwareOperations {
  constructor(private readonly db: SqliteDb) {}

  async receive(
    input: Pick<SoftwareResult, "operationId" | "action" | "spec"> & {
      requestedBy?: string;
      manifestDigest?: string;
      durableReplay?: boolean;
    },
  ): Promise<ExecutionIdentity | undefined> {
    if (
      input.durableReplay &&
      (!input.requestedBy || !/^sha256:[0-9a-f]{64}$/.test(input.manifestDigest ?? ""))
    )
      throw new SoftwareOperationIntentConflict(
        "Durable software request lacks its immutable material identity",
      );
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify([
          input.action,
          input.spec,
          input.requestedBy ?? "",
          input.manifestDigest ?? "",
        ]),
      )
      .digest("hex");
    const identity = await executionIdentity();
    const inserted = await this.db
      .insert(softwareExecutions)
      .values({
        operationId: input.operationId,
        action: input.action,
        spec: input.spec,
        identity,
        requestDigest,
      })
      .onConflictDoNothing()
      .returning({ operationId: softwareExecutions.operationId });
    if (inserted.length) return identity;
    const [saved] = await this.db
      .select()
      .from(softwareExecutions)
      .where(eq(softwareExecutions.operationId, input.operationId));
    if (!saved) throw new Error(RECOVERY_REQUIRED);
    if (
      saved.action !== input.action ||
      saved.spec !== input.spec ||
      (saved.requestDigest && saved.requestDigest !== requestDigest) ||
      (input.durableReplay && !saved.requestDigest)
    )
      throw new SoftwareOperationIntentConflict(
        "Software operation ID cannot change its request identity",
      );
    return undefined;
  }

  async start(operationId: string): Promise<void> {
    await this.db
      .update(softwareExecutions)
      .set({ started: true })
      .where(
        and(eq(softwareExecutions.operationId, operationId), isNull(softwareExecutions.result)),
      );
  }

  async bindStore(operationId: string, storeRoot: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(softwareExecutions)
      .where(eq(softwareExecutions.operationId, operationId));
    if (!row || row.result || (row.storeRoot && row.storeRoot !== storeRoot))
      throw new Error(RECOVERY_REQUIRED);
    await this.db
      .update(softwareExecutions)
      .set({ storeRoot })
      .where(eq(softwareExecutions.operationId, operationId));
  }

  async finish(result: SoftwareResult): Promise<SoftwareResult> {
    if (result.status === SoftwareOperationStatus.RUNNING) return result;
    // Terminal-only receipts also cover preflight refusal and legacy operations without Linux identity.
    await this.db
      .insert(softwareExecutions)
      .values({
        operationId: result.operationId,
        action: result.action,
        spec: result.spec,
        identity: {},
        result: { ...result },
      })
      .onConflictDoNothing();
    // First terminal wins locally too; a late failure must not replace a saved success.
    await this.db
      .update(softwareExecutions)
      .set({ result: { ...result } })
      .where(
        and(
          eq(softwareExecutions.operationId, result.operationId),
          isNull(softwareExecutions.result),
        ),
      );
    const [row] = await this.db
      .select({ result: softwareExecutions.result })
      .from(softwareExecutions)
      .where(eq(softwareExecutions.operationId, result.operationId));
    return row?.result ? ResultSchema.parse(row.result) : result;
  }

  // shortcut: retain terminal receipts until the protocol provides a durable Server ACK.
  async *results(): AsyncGenerator<SoftwareResult> {
    let after = "";
    while (true) {
      const rows = await this.db
        .select()
        .from(softwareExecutions)
        .where(and(isNotNull(softwareExecutions.result), gt(softwareExecutions.operationId, after)))
        .orderBy(asc(softwareExecutions.operationId))
        .limit(100);
      if (!rows.length) return;
      for (const row of rows) {
        yield ResultSchema.parse(row.result);
        after = row.operationId;
      }
    }
  }

  async recover(): Promise<void> {
    const rows = await this.db
      .select()
      .from(softwareExecutions)
      .where(isNull(softwareExecutions.result));
    if (!rows.length) return;
    const current = await executionIdentity();
    for (const row of rows) {
      const owner = ExecutionIdentitySchema.parse(row.identity);
      const state = await executionState(owner, current);
      // A reconnect does not end a live execution; remote hosts are never inferred dead.
      if (state === "alive" || state === "unknown") continue;
      let error = INTERRUPTED;
      if (row.storeRoot) {
        try {
          await new SpackInstallStore(row.storeRoot).withLock(async () => {});
        } catch {
          error = RECOVERY_REQUIRED;
        }
      } else if (row.started && state !== "rebooted") {
        error = RECOVERY_REQUIRED;
      }
      await this.finish({
        operationId: row.operationId,
        action: ResultSchema.shape.action.parse(row.action),
        spec: row.spec,
        status: SoftwareOperationStatus.FAILED,
        exitCode: 1,
        error,
      });
    }
  }
}
