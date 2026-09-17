import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAgentRegistrationToken,
  editSoftwarePolicy,
  getAgentRegistrationContext,
  getDashboardKpis,
  listActiveAgentRegistrationTokens,
  listAgents,
  listCpAgentCerts,
  listSoftwarePolicies,
  listUsers,
  reviewPreinstalledMapping,
  revokeAgentRegistrationToken,
  revokeCpAgentCert,
  searchAudit,
  setUserQuota,
  setUserSuspended,
} from "./cp-client";

type FetchSpy = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function captureFetch(body: unknown, init?: ResponseInit): FetchSpy {
  const spy = vi.fn(() => Promise.resolve(jsonResponse(body, init)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function getCall(spy: FetchSpy, idx = 0): { url: string; init: RequestInit | undefined } {
  const call = spy.mock.calls[idx];
  if (!call) throw new Error(`fetch call #${idx} missing`);
  const url = typeof call[0] === "string" ? call[0] : (call[0] as URL).toString();
  return { url, init: call[1] as RequestInit | undefined };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDashboardKpis", () => {
  test("hits GET /api/cp/dashboard and returns kpis", async () => {
    const kpis = {
      windowFrom: "2026-04-30T00:00:00Z",
      windowTo: "2026-05-01T00:00:00Z",
      jobsCompleted: 12,
      jobsFailed: 3,
      bytesTransferred: 99,
      queueDepthPeak: 4,
      agentsHealthy: 5,
      agentsSick: 1,
      agentsOffline: 2,
      topUsers: [],
      topApps: [],
    };
    const spy = captureFetch({ kpis });
    const out = await getDashboardKpis();
    expect(out).toEqual(kpis);
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/dashboard");
    expect(init?.method ?? "GET").toBe("GET");
  });

  test("attaches Authorization header when a token is set", async () => {
    localStorage.setItem("kq_token", "tok-1");
    const spy = captureFetch({ kpis: {} });
    await getDashboardKpis().catch(() => undefined);
    const { init } = getCall(spy);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-1" });
    expect(init?.credentials).toBe("same-origin");
  });
});

describe("listSoftwarePolicies", () => {
  test("returns items from /api/cp/software/policies", async () => {
    const items = [{ cluster: "c1", whitelist: ["a"], blacklist: [], locked: false }];
    const spy = captureFetch({ items });
    const out = await listSoftwarePolicies();
    expect(out).toEqual(items);
    expect(getCall(spy).url).toBe("/platform/api/cp/software/policies");
  });
});

describe("editSoftwarePolicy", () => {
  test("POSTs JSON body to /api/cp/software/policies", async () => {
    const spy = captureFetch({ ok: true });
    await editSoftwarePolicy({ cluster: "c1", list: "whitelist", specs: ["s1", "s2"] });
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/software/policies");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({ cluster: "c1", list: "whitelist", specs: ["s1", "s2"] }),
    );
    expect((init?.headers as Record<string, string>)?.["Content-Type"]).toBe("application/json");
  });
});

describe("reviewPreinstalledMapping", () => {
  test("POSTs review decision to the mapping review endpoint", async () => {
    const overview = {
      providerOrgIds: [],
      providerPolicy: null,
      clusters: [],
      agents: [],
      summary: {
        clusters: 0,
        agents: 0,
        lockedAgents: 0,
        overrides: 0,
        mirrors: 0,
        preinstalledSpecs: 0,
        installedSpecs: 0,
      },
    };
    const spy = captureFetch(overview);

    const out = await reviewPreinstalledMapping({
      agentId: "agent/1",
      mappingId: "mapping/1",
      decision: "approve",
    });

    expect(out).toEqual(overview);
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/software/preinstalled-mappings/mapping%2F1/review");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ agentId: "agent/1", decision: "approve" }));
  });
});

describe("listUsers", () => {
  test("appends search/limit/offset params when provided", async () => {
    const spy = captureFetch({ total: 0, items: [] });
    await listUsers({ search: "ab", limit: 10, offset: 20 });
    const { url } = getCall(spy);
    expect(url.startsWith("/platform/api/cp/users?")).toBe(true);
    expect(url).toContain("search=ab");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });

  test("omits params when not provided", async () => {
    const spy = captureFetch({ total: 0, items: [] });
    await listUsers({});
    const { url } = getCall(spy);
    expect(url).toBe("/platform/api/cp/users");
  });
});

describe("setUserSuspended", () => {
  test("POSTs to /api/cp/users/:id/suspend with body", async () => {
    const spy = captureFetch({ ok: true });
    await setUserSuspended("u-1", true);
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/users/u-1/suspend");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ suspended: true }));
  });
});

describe("setUserQuota", () => {
  test("POSTs to /api/cp/users/:id/quota with body", async () => {
    const spy = captureFetch({ ok: true });
    await setUserQuota("u-1", 42);
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/users/u-1/quota");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ quota: 42 }));
  });
});

describe("searchAudit", () => {
  test("POSTs the query body to /api/cp/audit/search", async () => {
    const spy = captureFetch({ total: 0, items: [] });
    await searchAudit({
      from: "2026-04-30T00:00:00Z",
      to: "2026-05-01T00:00:00Z",
      text: "login",
      limit: 25,
      offset: 0,
    });
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/audit/search");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent.from).toBe("2026-04-30T00:00:00Z");
    expect(sent.to).toBe("2026-05-01T00:00:00Z");
    expect(sent.text).toBe("login");
    expect(sent.limit).toBe(25);
    expect(sent.offset).toBe(0);
  });
});

describe("listAgents", () => {
  test("returns items from /api/cp/agents", async () => {
    const items = [{ id: "a-1", hostname: "h1", siteId: "s1", status: "online" }];
    const spy = captureFetch({ items });
    const out = await listAgents();
    expect(out).toEqual(items);
    expect(getCall(spy).url).toBe("/platform/api/cp/agents");
  });
});

describe("CP agent certs", () => {
  test("GETs cert metadata for one CP agent", async () => {
    const certs = [
      {
        id: "cert-1",
        fingerprintSha256: "a".repeat(64),
        subjectCn: "agent/1",
        issuedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        revokedAt: null,
        issuedBy: "user-1",
      },
    ];
    const spy = captureFetch({ certs });
    const out = await listCpAgentCerts("agent/1");
    expect(out).toEqual(certs);
    expect(getCall(spy).url).toBe("/platform/api/cp/agents/agent%2F1/certs");
  });

  test("POSTs one CP agent cert revocation by fingerprint", async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", spy);
    await revokeCpAgentCert("agent/1", "b".repeat(64), "key rotation");
    const { url, init } = getCall(spy);
    expect(url).toBe(`/platform/api/cp/agents/agent%2F1/certs/${"b".repeat(64)}/revoke`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ reason: "key rotation" }));
  });
});

describe("agent registration tokens", () => {
  test("GETs registration context from /api/cp/agent-registration-context", async () => {
    const context = {
      providerOrgs: [{ id: "org-1", name: "Provider One" }],
      isPlatformWide: false,
      schedulers: ["slurm", "pbs-pro", "torque", "kubernetes"],
    };
    const spy = captureFetch(context);
    const out = await getAgentRegistrationContext();
    expect(out).toEqual(context);
    expect(getCall(spy).url).toBe("/platform/api/cp/agent-registration-context");
  });

  test("POSTs create payload to /api/cp/agent-registration-tokens", async () => {
    const token = {
      id: "intent-1",
      agentId: "agent-1",
      siteName: "site-a",
      providerOrgId: "org-1",
      token: "kqreg_plain",
      expiresAt: "2026-07-07T00:00:00Z",
    };
    const spy = captureFetch(token);
    const out = await createAgentRegistrationToken({
      providerOrgId: "org-1",
      agentId: "agent-1",
      siteName: "site-a",
      expiresInSec: 3600,
    });
    expect(out).toEqual(token);
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/agent-registration-tokens");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        providerOrgId: "org-1",
        agentId: "agent-1",
        siteName: "site-a",
        expiresInSec: 3600,
      }),
    );
  });

  test("GETs active registration tokens without requiring plaintext tokens", async () => {
    const items = [
      {
        id: "intent-active-a",
        agentId: "agent-a",
        siteName: "site-a",
        providerOrgId: "org-a",
        expiresAt: "2026-07-07T00:00:00Z",
        createdAt: "2026-07-06T00:00:00Z",
      },
    ];
    const spy = captureFetch({ items });
    const out = await listActiveAgentRegistrationTokens();
    expect(out).toEqual(items);
    expect(getCall(spy).url).toBe("/platform/api/cp/agent-registration-tokens");
  });

  test("DELETEs a registration token by id", async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", spy);
    await revokeAgentRegistrationToken("intent/1");
    const { url, init } = getCall(spy);
    expect(url).toBe("/platform/api/cp/agent-registration-tokens/intent%2F1");
    expect(init?.method).toBe("DELETE");
  });
});

describe("error handling", () => {
  test("non-2xx response throws an Error with status info", async () => {
    captureFetch(
      { error: { code: "FORBIDDEN", message: "no scope", details: { reason: "RBAC" } } },
      { status: 403 },
    );
    await expect(getDashboardKpis()).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "no scope",
      details: { reason: "RBAC" },
    });
  });
});
