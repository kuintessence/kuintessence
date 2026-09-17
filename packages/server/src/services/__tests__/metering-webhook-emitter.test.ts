// Tests for `MeteringWebhookEmitter` — emits `usage.daily` summaries.
//
// Fully Docker / PG free: a fake repo, a fake query port, and a real
// WebhookDispatcher with a stub fetch so the fanout path is exercised
// end-to-end without network or storage.

import { describe, expect, it } from "bun:test";
import pino from "pino";
import type { QueryRequest, QueryResult, TenantScope } from "../metering";
import { type FetchLike, type WebhookConfig, WebhookDispatcher } from "../metering-webhook";
import type { MeteringQueryPort, WebhookEmitterRepository } from "../metering-webhook-emitter";
import { MeteringWebhookEmitter } from "../metering-webhook-emitter";

const silentLogger = pino({ level: "silent" });

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b2";

function makeResult(groupKey: string): QueryResult {
  return {
    rows: [
      {
        groupKey,
        cpuCoreSeconds: 1,
        gpuSeconds: 2,
        memoryMbSeconds: 3,
        storageMbSeconds: 4,
        networkEgressMb: 5,
        jobCount: 6,
      },
    ],
    total: 1,
  };
}

class FakeQuery implements MeteringQueryPort {
  calls: Array<{ scope: TenantScope; req: QueryRequest }> = [];
  throwForOrg: string | null = null;
  resultByOrg: Record<string, QueryResult> = {};
  resultByPeriod: Partial<Record<QueryRequest["period"], QueryResult>> | null = null;
  async query(scope: TenantScope, req: QueryRequest): Promise<QueryResult> {
    this.calls.push({ scope, req });
    if (scope.kind === "orgs" && scope.orgIds[0] === this.throwForOrg) {
      throw new Error("query boom");
    }
    if (this.resultByPeriod) {
      return this.resultByPeriod[req.period] ?? { rows: [], total: 0 };
    }
    const org = scope.kind === "orgs" ? (scope.orgIds[0] ?? "") : "*";
    return this.resultByOrg[org] ?? makeResult(org);
  }
}

class FakeRepo implements WebhookEmitterRepository {
  recorded: Array<{ id: string; ok: boolean }> = [];
  constructor(private readonly webhooks: WebhookConfig[]) {}
  async listEnabledForEvent(event: string): Promise<WebhookConfig[]> {
    return this.webhooks.filter((w) => w.events.includes(event));
  }
  async recordResult(id: string, ok: boolean): Promise<void> {
    this.recorded.push({ id, ok });
  }
}

function webhook(over: Partial<WebhookConfig>): WebhookConfig {
  return {
    id: crypto.randomUUID(),
    orgId: ORG_A,
    url: "https://hook.test/endpoint",
    secret: "s3cr3t",
    enabled: true,
    events: ["usage.daily"],
    failures: 0,
    ...over,
  };
}

const DAY_START = new Date("2026-04-29T00:00:00Z");
const DAY_END = new Date("2026-04-30T00:00:00Z");

describe("MeteringWebhookEmitter", () => {
  it("returns a zero report when no webhooks are subscribed", async () => {
    const repo = new FakeRepo([]);
    const query = new FakeQuery();
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({ fetch: okFetch(), resolveTarget: resolveTestTarget }),
      logger: silentLogger,
    });
    const report = await emitter.emitDailySummary(DAY_START, DAY_END);
    expect(report).toEqual({ orgs: 0, sent: 0, failed: 0 });
    expect(query.calls.length).toBe(0);
  });

  it("queries once per org with the org scope and the prev-day window", async () => {
    const hookA1 = webhook({ orgId: ORG_A });
    const hookA2 = webhook({ orgId: ORG_A });
    const hookB = webhook({ orgId: ORG_B });
    const repo = new FakeRepo([hookA1, hookA2, hookB]);
    const query = new FakeQuery();
    query.resultByOrg = { [ORG_A]: makeResult("A"), [ORG_B]: makeResult("B") };
    const sent: Array<{ url: string; body: string }> = [];
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({
        fetch: captureFetch(sent),
        resolveTarget: resolveTestTarget,
      }),
      logger: silentLogger,
    });

    const report = await emitter.emitDailySummary(DAY_START, DAY_END);

    // Two orgs => two queries (deduplicated by orgId).
    expect(query.calls.length).toBe(2);
    for (const call of query.calls) {
      expect(call.scope.kind).toBe("orgs");
      expect(call.req.period).toBe("raw");
      expect(call.req.grouping).toBe("org");
      expect(call.req.from).toBe(DAY_START.toISOString());
      expect(call.req.to).toBe(DAY_END.toISOString());
    }
    const scopedOrgs = query.calls
      .map((c) => (c.scope.kind === "orgs" ? c.scope.orgIds[0] : null))
      .sort();
    expect(scopedOrgs).toEqual([ORG_A, ORG_B].sort());

    // 3 webhooks all delivered (2 for A, 1 for B).
    expect(report).toEqual({ orgs: 2, sent: 3, failed: 0 });
    expect(repo.recorded.length).toBe(3);
    expect(repo.recorded.every((r) => r.ok)).toBe(true);

    // The body for org-A's webhooks carries org-A's query result.
    const bodyForA = JSON.parse(sent.find((s) => s.body.includes('"A"'))?.body ?? "{}");
    expect(bodyForA.event).toBe("usage.daily");
    expect(bodyForA.orgId).toBe(ORG_A);
    expect(bodyForA.payload).toEqual(makeResult("A"));
  });

  it("records a failed dispatch as ok=false and tallies it", async () => {
    const hook = webhook({ orgId: ORG_A });
    const repo = new FakeRepo([hook]);
    const query = new FakeQuery();
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({
        fetch: failFetch(),
        maxAttempts: 1,
        resolveTarget: resolveTestTarget,
      }),
      logger: silentLogger,
    });
    const report = await emitter.emitDailySummary(DAY_START, DAY_END);
    expect(report).toEqual({ orgs: 1, sent: 0, failed: 1 });
    expect(repo.recorded).toEqual([{ id: hook.id, ok: false }]);
  });

  it("continues with other orgs when one org's query throws", async () => {
    const hookA = webhook({ orgId: ORG_A });
    const hookB = webhook({ orgId: ORG_B });
    const repo = new FakeRepo([hookA, hookB]);
    const query = new FakeQuery();
    query.throwForOrg = ORG_A;
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({ fetch: okFetch(), resolveTarget: resolveTestTarget }),
      logger: silentLogger,
    });
    const report = await emitter.emitDailySummary(DAY_START, DAY_END);
    // Org A failed at the query stage (no dispatch), org B succeeded.
    expect(report).toEqual({ orgs: 2, sent: 1, failed: 0 });
    expect(repo.recorded).toEqual([{ id: hookB.id, ok: true }]);
  });
});

const MONTH_START = new Date("2026-04-01T00:00:00Z");
const MONTH_END = new Date("2026-05-01T00:00:00Z");

function tierResult(over: Partial<QueryResult["rows"][number]>): QueryResult {
  return {
    rows: [
      {
        groupKey: "A",
        cpuCoreSeconds: 0,
        gpuSeconds: 0,
        memoryMbSeconds: 0,
        storageMbSeconds: 0,
        networkEgressMb: 0,
        jobCount: 0,
        ...over,
      },
    ],
    total: 1,
  };
}

describe("MeteringWebhookEmitter monthly (cross-tier)", () => {
  it("queries all four tiers for the window and merges the sums per groupKey", async () => {
    const hook = webhook({ orgId: ORG_A, events: ["usage.monthly"] });
    const repo = new FakeRepo([hook]);
    const query = new FakeQuery();
    query.resultByPeriod = {
      raw: tierResult({ cpuCoreSeconds: 100, jobCount: 1 }),
      hourly: tierResult({ cpuCoreSeconds: 50, jobCount: 2 }),
      daily: { rows: [], total: 0 },
      monthly: { rows: [], total: 0 },
    };
    const sent: Array<{ url: string; body: string }> = [];
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({
        fetch: captureFetch(sent),
        resolveTarget: resolveTestTarget,
      }),
      logger: silentLogger,
    });

    const report = await emitter.emitMonthlySummary(MONTH_START, MONTH_END);

    // All four tiers queried for the single org, with the full month window.
    const periods = query.calls.map((c) => c.req.period).sort();
    expect(periods).toEqual(["daily", "hourly", "monthly", "raw"]);
    for (const call of query.calls) {
      expect(call.scope.kind).toBe("orgs");
      expect(call.req.grouping).toBe("org");
      expect(call.req.from).toBe(MONTH_START.toISOString());
      expect(call.req.to).toBe(MONTH_END.toISOString());
    }

    expect(report).toEqual({ orgs: 1, sent: 1, failed: 0 });

    const body = JSON.parse(sent[0]?.body ?? "{}");
    expect(body.event).toBe("usage.monthly");
    expect(body.orgId).toBe(ORG_A);
    expect(body.payload.rows.length).toBe(1);
    expect(body.payload.rows[0].groupKey).toBe("A");
    expect(body.payload.rows[0].cpuCoreSeconds).toBe(150);
    expect(body.payload.rows[0].jobCount).toBe(3);
    expect(body.payload.total).toBe(1);
  });

  it("delivers to usage.monthly subscribers but not usage.daily-only ones", async () => {
    const monthlyHook = webhook({ orgId: ORG_A, events: ["usage.monthly"] });
    const dailyHook = webhook({ orgId: ORG_A, events: ["usage.daily"] });
    const repo = new FakeRepo([monthlyHook, dailyHook]);
    const query = new FakeQuery();
    query.resultByPeriod = {
      raw: tierResult({ cpuCoreSeconds: 100, jobCount: 1 }),
      hourly: { rows: [], total: 0 },
      daily: { rows: [], total: 0 },
      monthly: { rows: [], total: 0 },
    };
    const sent: Array<{ url: string; body: string }> = [];
    const emitter = new MeteringWebhookEmitter({
      query,
      repo,
      dispatcher: new WebhookDispatcher({
        fetch: captureFetch(sent),
        resolveTarget: resolveTestTarget,
      }),
      logger: silentLogger,
    });

    const report = await emitter.emitMonthlySummary(MONTH_START, MONTH_END);

    // Only the usage.monthly subscriber is selected by listEnabledForEvent.
    expect(repo.recorded).toEqual([{ id: monthlyHook.id, ok: true }]);
    expect(report).toEqual({ orgs: 1, sent: 1, failed: 0 });
  });
});

function okFetch(): FetchLike {
  return async () => new Response("ok", { status: 200 });
}

async function resolveTestTarget(url: string) {
  return {
    url: new URL(url),
    addresses: [{ address: "203.0.113.5", family: 4 as const }],
  };
}

function failFetch(): FetchLike {
  return async () => new Response("nope", { status: 500 });
}

function captureFetch(sink: Array<{ url: string; body: string }>): FetchLike {
  return async (url, init) => {
    sink.push({ url, body: String(init.body) });
    return new Response("ok", { status: 200 });
  };
}
