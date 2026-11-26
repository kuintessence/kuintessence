import { agents, agentUpdateRequests, type PgDb } from "@kuintessence/db";
import {
  type AgentUpdateReport,
  type AgentUpdateRequest,
  AppError,
  createLogger,
  ErrorCode,
} from "@kuintessence/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AgentDispatcher } from "../grpc/dispatcher";

const activeStates = ["requested", "waiting", "applying", "restarting"];
export class AgentUpdateService {
  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  async list(agentId: string) {
    return this.db
      .select()
      .from(agentUpdateRequests)
      .where(eq(agentUpdateRequests.agentId, agentId))
      .orderBy(desc(agentUpdateRequests.createdAt))
      .limit(20);
  }

  async request(agentId: string, requestedBy: string, input: AgentUpdateRequest) {
    const result = await this.db.transaction(async (tx) => {
      // Serialize the per-Agent active request check, including disconnected Agents.
      await tx.select().from(agents).where(eq(agents.agentId, agentId)).for("update");
      const [existing] = await tx
        .select()
        .from(agentUpdateRequests)
        .where(eq(agentUpdateRequests.requestId, input.requestId));
      if (existing) {
        if (
          existing.agentId !== agentId ||
          existing.requestedBy !== requestedBy ||
          existing.kind !== input.kind ||
          existing.release !== input.release ||
          existing.message !== input.message
        )
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Update request ID was reused", 409);
        return existing;
      }
      if (input.kind === "update") {
        const [active] = await tx
          .select()
          .from(agentUpdateRequests)
          .where(
            and(
              eq(agentUpdateRequests.agentId, agentId),
              eq(agentUpdateRequests.kind, "update"),
              inArray(agentUpdateRequests.state, activeStates),
            ),
          );
        if (active)
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Agent already has a pending update", 409);
      }
      const [created] = await tx
        .insert(agentUpdateRequests)
        .values({ ...input, agentId, requestedBy })
        .returning();
      if (!created) throw new Error("Agent update request was not persisted");
      return created;
    });
    await this.deliver(agentId).catch((error: unknown) => {
      createLogger("agent-update").warn(
        { err: error, agentId },
        "Update saved; delivery will retry on heartbeat",
      );
    });
    return result;
  }

  async deliver(agentId: string) {
    const channel = this.dispatcher.getChannel(agentId);
    if (!channel?.agentUpdateV1) return;
    const [pending] = await this.db
      .select()
      .from(agentUpdateRequests)
      .where(
        and(
          eq(agentUpdateRequests.agentId, agentId),
          eq(agentUpdateRequests.kind, "update"),
          inArray(agentUpdateRequests.state, activeStates),
        ),
      )
      .limit(1);
    if (pending) this.dispatcher.pushAgentUpdate(agentId, pending.requestId, pending.release);
  }

  async report(agentId: string, report: AgentUpdateReport) {
    const preceding =
      report.state === "succeeded"
        ? activeStates
        : report.state === "failed" || report.state === "disabled"
          ? activeStates
          : activeStates.slice(0, activeStates.indexOf(report.state) + 1);
    if (!preceding.length) return;
    await this.db
      .update(agentUpdateRequests)
      .set({ state: report.state, updatedAt: new Date() })
      .where(
        and(
          eq(agentUpdateRequests.agentId, agentId),
          eq(agentUpdateRequests.kind, "update"),
          eq(agentUpdateRequests.requestId, report.requestId),
          eq(agentUpdateRequests.release, report.release),
          inArray(agentUpdateRequests.state, preceding),
        ),
      );
  }
}
