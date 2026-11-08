import { randomUUID } from "node:crypto";
import {
  federationMarketAttempts as attempts,
  auditLog,
  type PgDb,
  type PgTransaction,
  federationMarketSubmissions as submissions,
  federationExecutionTerminals as terminals,
  users,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketAdvanceResultSchema,
  MarketAdapterProposalInputSchema,
  type MarketProposalInput,
  MarketProposalInputSchema,
  type MarketQueryInput,
  MarketQueryInputSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { executionClosure } from "./execution-closure";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";

import type { FederationStorageGuard } from "./storage-capacity";

type Submission = typeof submissions.$inferSelect;
type Lease = { id: string; token: string };
class LeaseLost extends Error {}

export class FederationMarketService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly client?: MarketClient,
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {}
  private async claim(): Promise<Lease | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.state, "pending"),
            sql`${submissions.nextAttemptAt} <= clock_timestamp()`,
            sql`(${submissions.leaseToken} IS NULL OR ${submissions.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(submissions.nextAttemptAt), asc(submissions.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(submissions)
        .set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
        .where(eq(submissions.id, row.id));
      return { id: row.id, token };
    });
  }

  private fenced<T>(
    lease: Lease,
    operation: (tx: PgTransaction, submission: Submission) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, lease.id),
            eq(submissions.localSiteId, this.siteId),
            eq(submissions.state, "pending"),
            eq(submissions.leaseToken, lease.token),
            sql`${submissions.leaseUntil} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!row) throw new LeaseLost();
      const result = await operation(tx, row);
      const [valid] = await tx
        .select({ valid: sql<boolean>`${submissions.leaseUntil} > clock_timestamp()` })
        .from(submissions)
        .where(eq(submissions.id, row.id));
      if (!valid?.valid) throw new LeaseLost();
      return result;
    });
  }

  private latest(tx: PgTransaction, id: string) {
    return tx
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, id))
      .orderBy(desc(attempts.number))
      .limit(1);
  }

  /** One checkpoint per call: a transaction can never be submitted before its bytes are committed. */
  async advanceNext(): Promise<boolean> {
    if (!this.client) return false;
    const lease = await this.claim();
    if (!lease) return false;
    const claimed = lease;
    try {
      const snapshot = await this.fenced(claimed, async (tx, submission) => ({
        submission,
        attempt: (await this.latest(tx, submission.id))[0],
      }));
      const { submission, attempt } = snapshot;
      if (!attempt || attempt.stage === "invalid" || attempt.stage === "abandoned") {
        await this.validate(submission);
        const result = FabricProposalCheckpointSchema.parse(
          await this.client.prepare(submission.input),
        );
        await this.fenced(claimed, async (tx) => {
          await tx.insert(attempts).values({
            id: randomUUID(),
            submissionId: submission.id,
            number: (attempt?.number ?? 0) + 1,
            transactionId: result.transactionId,
            recovery: result.recovery,
          });
          await this.schedule(tx, submission.id);
        });
      } else {
        if (attempt.stage === "proposal") await this.validate(submission);
        const result = FabricMarketAdvanceResultSchema.parse(
          await this.client.advance(attempt.recovery),
        );
        if (
          result.transactionId !== attempt.transactionId ||
          (attempt.stage === "proposal" && result.state !== "prepared") ||
          (attempt.stage === "transaction" && result.state === "prepared") ||
          (result.state === "pending" && result.recovery !== attempt.recovery)
        )
          throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
        await this.fenced(claimed, async (tx) => {
          if (result.state === "prepared") {
            await tx
              .update(attempts)
              .set({
                stage: "transaction",
                recovery: result.recovery,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, submission.id);
          } else if (result.state === "pending") {
            await this.schedule(tx, submission.id, "LEDGER_PENDING");
          } else {
            await tx
              .update(attempts)
              .set({
                stage: result.state,
                validationCode: result.state === "committed" ? 0 : result.validationCode,
                blockNumber: result.blockNumber,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await tx
              .update(submissions)
              .set({
                state: result.state === "committed" ? "committed" : "needs_review",
                lastError: result.state === "committed" ? null : "LEDGER_INVALID",
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(submissions.id, submission.id));
          }
        });
      }
    } catch (error) {
      if (!(error instanceof LeaseLost)) {
        const failure =
          error instanceof FabricClientFailure
            ? error
            : error instanceof FederationError
              ? new FabricClientFailure(error.code, true)
              : error instanceof z.ZodError
                ? new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true)
                : new FabricClientFailure("MARKET_RETRY");
        try {
          await this.fenced(claimed, async (tx) => {
            await this.schedule(tx, claimed.id, failure.code);
            if (failure.needsReview)
              await tx
                .update(submissions)
                .set({ state: "needs_review" })
                .where(eq(submissions.id, claimed.id));
          });
        } catch (saveError) {
          if (!(saveError instanceof LeaseLost)) throw saveError;
        }
      }
    } finally {
      await this.db
        .update(submissions)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(submissions.id, claimed.id), eq(submissions.leaseToken, claimed.token)));
    }
    return true;
  }

  private async schedule(tx: PgTransaction, id: string, error: string | null = null) {
    await tx
      .update(submissions)
      .set({
        lastError: error,
        nextAttemptAt: error
          ? sql`clock_timestamp() + interval '30 seconds'`
          : sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(submissions.id, id));
  }

  private async validate(row: Submission) {
    const input = MarketAdapterProposalInputSchema.parse(row.input);
    if (federationMaterialDigest(input) !== row.digest)
      throw new FederationError("OPERATION_CONFLICT");
    if (input.operation === "close-demand") {
      const closure = await this.db.transaction((tx) => executionClosure(tx, this.siteId, row.id));
      if (
        row.localOrgId !== closure.localOrgId ||
        row.requestedBy !== closure.requestedBy ||
        row.demandId !== closure.input.closure.demandId ||
        federationMaterialDigest(closure.input) !== row.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    if (input.operation === "authorize-execution" || input.operation === "request-execution-stop") {
      const [terminal] = await this.db
        .select({ id: terminals.terminalId })
        .from(terminals)
        .where(
          and(
            eq(terminals.localSiteId, this.siteId),
            input.operation === "authorize-execution"
              ? eq(terminals.reservationId, input.authorization.gate.reservationId)
              : sql`${terminals.payload}->>'activationId' = ${input.stop.activationId}`,
          ),
        )
        .limit(1);
      if (terminal) throw new FabricClientFailure("EXECUTION_TERMINAL", true);
    }
    return input;
  }
  async enqueue(actor: FederationActor, raw: MarketProposalInput) {
    const input = MarketProposalInputSchema.parse(raw);
    const capability = input.operation === "claim-demand" ? "market.claim" : "market.publish";
    const id =
      input.operation === "publish-demand"
        ? input.demand.demandId
        : input.operation === "claim-demand"
          ? input.claim.claimId
          : input.cancellation.cancellationId;
    const demandId =
      input.operation === "publish-demand"
        ? input.demand.demandId
        : input.operation === "claim-demand"
          ? input.claim.demandId
          : input.cancellation.demandId;
    const digest = federationMaterialDigest(input);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, capability);
      const [prior] = await tx.select().from(submissions).where(eq(submissions.id, id));
      if (prior) {
        if (prior.localSiteId !== this.siteId || prior.localOrgId !== actor.orgId)
          throw new FederationError("POLICY_DENIED");
        if (prior.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return { id: prior.id, state: prior.state, demandId: prior.demandId };
      }
      if (
        (input.operation === "publish-demand" && input.demand.sourceSiteId !== this.siteId) ||
        (input.operation === "claim-demand" && input.claim.providerSiteId !== this.siteId)
      )
        throw new FederationError("POLICY_DENIED");
      if (input.operation === "cancel-open-demand") {
        const [published] = await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.id, demandId),
              eq(submissions.localOrgId, actor.orgId),
              eq(submissions.localSiteId, this.siteId),
              eq(submissions.state, "committed"),
            ),
          )
          .for("share");
        if (published?.input.operation !== "publish-demand")
          throw new FederationError("ASSET_UNAVAILABLE");
      } else {
        await this.storageGuard?.assertAdmission("ledger_coordinated");
        const [clock] = await tx
          .select({ now: sql<Date>`clock_timestamp()` })
          .from(users)
          .where(eq(users.id, actor.userId));
        const now = new Date(clock?.now ?? NaN).getTime();
        const value = input.operation === "publish-demand" ? input.demand : input.claim;
        if (
          !Number.isFinite(now) ||
          Date.parse(value.expiresAt) <= now ||
          (input.operation === "publish-demand" && Date.parse(input.demand.createdAt) > now + 60000)
        )
          throw new FederationError("AUTHORIZATION_EXPIRED");
      }
      const inserted = await tx
        .insert(submissions)
        .values({
          id,
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          requestedBy: actor.userId,
          demandId,
          digest,
          input,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [winner] = await tx.select().from(submissions).where(eq(submissions.id, id));
        if (winner?.localOrgId !== actor.orgId || winner?.localSiteId !== this.siteId)
          throw new FederationError("POLICY_DENIED");
        if (winner.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return { id: winner.id, state: winner.state, demandId: winner.demandId };
      }
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.market.enqueue",
        target: id,
        diff: { after: { operation: input.operation, demandId, digest } },
      });
      return { id, state: "pending", demandId };
    });
  }
  private owned(actor: FederationActor, id?: string) {
    return and(
      eq(submissions.localSiteId, this.siteId),
      eq(submissions.localOrgId, actor.orgId),
      id ? eq(submissions.id, id) : undefined,
    );
  }
  private publicRow(row: Submission) {
    return {
      id: row.id,
      demandId: row.demandId,
      input: row.input,
      digest: row.digest,
      state: row.state,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  async query(actor: FederationActor, raw: MarketQueryInput) {
    const input = MarketQueryInputSchema.parse(raw);
    await this.db.transaction((tx) => requireFederationCapability(tx, actor, "market.read"));
    if (!this.client) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const rawResult = await this.client.query(input).catch((error: unknown) => {
      if (error instanceof z.ZodError)
        throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
      throw error;
    });
    const parsed = MarketQueryResultSchema.safeParse(rawResult);
    if (!parsed.success) throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const result = parsed.data;
    if (
      result.operation !== input.operation ||
      (input.operation === "get-demand" &&
        result.operation === "get-demand" &&
        result.demand &&
        result.demand.demand.demandId !== input.demandId) ||
      (input.operation === "list-demands" &&
        result.operation === "list-demands" &&
        result.demands.length > input.limit)
    )
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    // No database lock during network I/O; a revoked reader cannot receive a late response.
    await this.db.transaction((tx) => requireFederationCapability(tx, actor, "market.read"));
    return { ...result, observedAt: new Date().toISOString() };
  }
  async list(actor: FederationActor, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "market.read");
      const rows = await tx
        .select()
        .from(submissions)
        .where(this.owned(actor))
        .orderBy(desc(submissions.createdAt), desc(submissions.id))
        .limit(limit + 1)
        .offset(offset);
      return {
        enabled: Boolean(this.client),
        data: rows.slice(0, limit).map((row) => this.publicRow(row)),
        hasMore: rows.length > limit,
      };
    });
  }
  async get(actor: FederationActor, id: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "market.read");
      const [row] = await tx.select().from(submissions).where(this.owned(actor, id));
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      const transactions = await tx
        .select({
          number: attempts.number,
          transactionId: attempts.transactionId,
          stage: attempts.stage,
          validationCode: attempts.validationCode,
          blockNumber: attempts.blockNumber,
        })
        .from(attempts)
        .where(eq(attempts.submissionId, id))
        .orderBy(desc(attempts.number))
        .limit(limit + 1)
        .offset(offset);
      return {
        enabled: Boolean(this.client),
        operation: this.publicRow(row),
        transactions: transactions.slice(0, limit),
        hasMore: transactions.length > limit,
      };
    });
  }
  async retry(actor: FederationActor, id: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "market.read");
      const [row] = await tx.select().from(submissions).where(this.owned(actor, id)).for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      await requireFederationCapability(
        tx,
        actor,
        row.input.operation === "authorize-execution" ||
          row.input.operation === "request-execution-stop" ||
          row.input.operation === "close-demand"
          ? "agreement.approve"
          : row.input.operation === "claim-demand"
            ? "market.claim"
            : "market.publish",
      );
      if (row.input.operation === "activate-demand")
        await requireFederationCapability(tx, actor, "agreement.approve");
      const [time] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(users)
        .where(eq(users.id, actor.userId));
      if (
        row.state !== "needs_review" ||
        (row.leaseUntil && row.leaseUntil > new Date(time?.now ?? NaN))
      )
        throw new FederationError("OPERATION_CONFLICT");
      this.validate(row);
      const [attempt] = await this.latest(tx, id);
      if (attempt?.stage === "proposal")
        await tx
          .update(attempts)
          .set({ stage: "abandoned", updatedAt: sql`clock_timestamp()` })
          .where(eq(attempts.id, attempt.id));
      // A submitted transaction can only resume; never replace an unknown outcome with a new request.
      await tx
        .update(submissions)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(submissions.id, id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.market.retry",
        target: id,
        diff: { after: { previousError: row.lastError } },
      });
    });
  }
}
