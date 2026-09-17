// scorer unit tests.
import { describe, expect, it } from "bun:test";
import {
  type AgentCandidate,
  CompositeScorer,
  costScorer,
  defaultScorers,
  loadScorer,
  localityScorer,
  type PlacementContext,
  queueWaitScorer,
} from "../index";

function candidate(overrides: Partial<AgentCandidate> = {}): AgentCandidate {
  return {
    agentId: "a1",
    siteId: "groupa-site-1",
    clusterName: "cluster-A",
    loadPercent: 50,
    queueDepth: 0,
    historicalP95WaitSec: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    dataSites: [],
    costRates: {},
    expectedCpuHours: 1,
    expectedWallSec: 3600,
    ...overrides,
  };
}

describe("loadScorer", () => {
  it("100 at zero load, 0 at full load", () => {
    expect(loadScorer.score(candidate({ loadPercent: 0 }), ctx())).toBe(100);
    expect(loadScorer.score(candidate({ loadPercent: 100 }), ctx())).toBe(0);
    expect(loadScorer.score(candidate({ loadPercent: 50 }), ctx())).toBe(50);
  });
  it("clamps out-of-range values", () => {
    expect(loadScorer.score(candidate({ loadPercent: 150 }), ctx())).toBe(0);
    expect(loadScorer.score(candidate({ loadPercent: -10 }), ctx())).toBe(100);
  });
});

describe("costScorer", () => {
  it("cheapest cluster scores 100", () => {
    const c = ctx({ costRates: { A: 1, B: 5 } });
    expect(costScorer.score(candidate({ clusterName: "A" }), c)).toBe(100);
  });
  it("expensive cluster scores 0 at >=5x", () => {
    const c = ctx({ costRates: { A: 1, B: 5 } });
    expect(costScorer.score(candidate({ clusterName: "B" }), c)).toBe(0);
  });
  it("missing cluster pricing returns neutral 50", () => {
    expect(costScorer.score(candidate({ clusterName: "X" }), ctx())).toBe(50);
  });
  it("monotonic: cheaper rate => higher score", () => {
    const cAll = ctx({ costRates: { A: 1, B: 2, C: 3 } });
    const sa = costScorer.score(candidate({ clusterName: "A" }), cAll);
    const sb = costScorer.score(candidate({ clusterName: "B" }), cAll);
    const sc = costScorer.score(candidate({ clusterName: "C" }), cAll);
    expect(sa).toBeGreaterThan(sb);
    expect(sb).toBeGreaterThan(sc);
  });
});

describe("localityScorer", () => {
  it("100 when site matches dataSites", () => {
    expect(
      localityScorer.score(
        candidate({ siteId: "groupa-site-1" }),
        ctx({ dataSites: ["groupa-site-1"] }),
      ),
    ).toBe(100);
  });
  it("60 when same region prefix", () => {
    expect(
      localityScorer.score(
        candidate({ siteId: "groupa-site-1" }),
        ctx({ dataSites: ["groupa-site-2"] }),
      ),
    ).toBe(60);
  });
  it("30 when no match", () => {
    expect(
      localityScorer.score(
        candidate({ siteId: "groupb-site-1" }),
        ctx({ dataSites: ["groupa-site-1"] }),
      ),
    ).toBe(30);
  });
  it("50 (neutral) when no data site declared", () => {
    expect(
      localityScorer.score(candidate({ siteId: "groupa-site-1" }), ctx({ dataSites: [] })),
    ).toBe(50);
  });
});

describe("queueWaitScorer", () => {
  it("100 when no historical wait", () => {
    expect(queueWaitScorer.score(candidate({ historicalP95WaitSec: 0 }), ctx())).toBe(100);
  });
  it("0 when wait dwarfs expected runtime", () => {
    expect(
      queueWaitScorer.score(
        candidate({ historicalP95WaitSec: 36_000 }),
        ctx({ expectedWallSec: 3600 }),
      ),
    ).toBe(0);
  });
  it("intermediate score for moderate wait", () => {
    const s = queueWaitScorer.score(
      candidate({ historicalP95WaitSec: 1800 }),
      ctx({ expectedWallSec: 3600 }),
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(100);
  });
});

describe("CompositeScorer", () => {
  it("ranks candidates by weighted total", () => {
    const cs = new CompositeScorer(defaultScorers);
    const candidates = [
      candidate({ agentId: "a-busy", loadPercent: 90 }),
      candidate({ agentId: "a-idle", loadPercent: 10 }),
    ];
    const ranked = cs.rank(
      candidates,
      ctx({ dataSites: ["groupa-site-1"], costRates: { "cluster-A": 1 } }),
    );
    expect(ranked[0]?.agentId).toBe("a-idle");
    expect(ranked[0]?.finalScore).toBeGreaterThan(
      ranked[1]?.finalScore ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("respects weight overrides", () => {
    const cs = new CompositeScorer(defaultScorers, {
      weightOverrides: { load: 1, cost: 0, locality: 0, "queue-wait": 0 },
    });
    const candidates = [
      candidate({ agentId: "a-busy", loadPercent: 90 }),
      candidate({ agentId: "a-idle", loadPercent: 10 }),
    ];
    const ranked = cs.rank(candidates, ctx());
    expect(ranked[0]?.agentId).toBe("a-idle");
    expect(ranked[0]?.finalScore).toBe(90); // load only: 100 - 10
    expect(ranked[1]?.finalScore).toBe(10);
  });

  it("breakdown attributes per-scorer contribution", () => {
    const cs = new CompositeScorer(defaultScorers);
    const b = cs.scoreOne(candidate(), ctx());
    expect(b.contributions.length).toBe(4);
    const names = b.contributions.map((c) => c.name).sort();
    expect(names).toEqual(["cost", "load", "locality", "queue-wait"]);
  });
});
