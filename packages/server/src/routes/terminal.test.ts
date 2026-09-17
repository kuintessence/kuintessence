import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService, ShadowCheckInput } from "../authz/service";
import { type AgentChannel, AgentDispatcher } from "../grpc/dispatcher";
import { createErrorHandler } from "../middleware/error-handler";
import { ShellExecRegistry } from "../services/shell-exec-registry";
import { TerminalService } from "../services/terminal-service";
import { createTerminalRoutes } from "./terminal";

const silent = pino({ level: "silent" });

function makeApp(
  dispatcher: AgentDispatcher,
  shellExecRegistry: ShellExecRegistry,
  authz?: AuthzService,
  options: {
    principalEmail?: string;
    principalRole?: string | null;
    principalUserId?: string | null;
    principalOrgId?: string | null;
    principalOrgIds?: string[];
    resolveAgentProviderOrg?: (agentId: string) => Promise<string | null | undefined>;
    shellExecTimeoutMs?: number;
    userEmail?: string;
  } = {},
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const userEmail = options.userEmail ?? "admin@terminal.test";
    const principalEmail = options.principalEmail ?? userEmail;
    const principalRole =
      options.principalRole === undefined ? "platform_admin" : options.principalRole;
    c.set("user", {
      sub: userEmail,
      email: userEmail,
      role: "platform_admin",
    });
    c.set("principal" as never, {
      sub: userEmail,
      email: principalEmail,
      role: principalRole,
      userId:
        options.principalUserId === undefined ? "user-terminal-admin" : options.principalUserId,
      orgId: options.principalOrgId ?? null,
      orgIds: options.principalOrgIds ?? [],
      memberships: [],
    });
    await next();
  });
  app.onError(createErrorHandler(silent));
  app.route(
    "/api",
    createTerminalRoutes(new TerminalService(), {
      dispatcher,
      shellExecRegistry,
      authz,
      resolveAgentProviderOrg: options.resolveAgentProviderOrg ?? (async () => "provider-terminal"),
      shellExecTimeoutMs: options.shellExecTimeoutMs,
    }),
  );
  return app;
}

function enforcingAuthz(handler: (check: AuthzCheck) => Promise<void> | void): AuthzService {
  return {
    mode: "enforce",
    requirePermission: handler,
    shadowCheck: async () => undefined,
  } as unknown as AuthzService;
}

function noopChannel(): AgentChannel {
  return {
    push: () => {},
    close: () => {},
  };
}

describe("terminal routes", () => {
  test("session ownership uses canonical principal user id instead of token email", async () => {
    const dispatcher = new AgentDispatcher();
    const shellExecRegistry = new ShellExecRegistry();
    const service = new TerminalService();
    dispatcher.register("agent-a", {
      push: (message) => {
        if (message.payload.case === "shellExecRequest") {
          shellExecRegistry.resolve(message.payload.value.requestId, {
            stdout: "/scratch\n",
            stderr: "",
            exitCode: 0,
            error: "",
          });
        }
      },
      close: () => {},
    });
    const createApp = (email: string) => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user", { sub: email, email, role: "platform_admin" });
        c.set("principal" as never, {
          sub: email,
          email,
          role: "platform_admin",
          userId: "canonical-terminal-user",
          orgId: null,
          orgIds: [],
          memberships: [],
        });
        await next();
      });
      app.onError(createErrorHandler(silent));
      app.route(
        "/api",
        createTerminalRoutes(service, {
          dispatcher,
          shellExecRegistry,
          resolveAgentProviderOrg: async () => "provider-terminal",
        }),
      );
      return app;
    };

    const created = await createApp("old-email@terminal.test").request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string; userId: string };
    expect(session.userId).toBe("canonical-terminal-user");

    const exec = await createApp("new-email@terminal.test").request(
      `/api/terminal/sessions/${session.id}/exec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "pwd\n" }),
      },
    );

    expect(exec.status).toBe(200);
  });

  test("exec dispatches to the agent selected for the session", async () => {
    const dispatcher = new AgentDispatcher();
    const shellExecRegistry = new ShellExecRegistry();
    let agentAPushes = 0;
    let agentBPushes = 0;
    const agentA: AgentChannel = {
      push: () => {
        agentAPushes += 1;
      },
      close: () => {},
    };
    const agentB: AgentChannel = {
      push: (msg) => {
        agentBPushes += 1;
        const payload = msg.payload;
        if (payload.case === "shellExecRequest") {
          shellExecRegistry.resolve(payload.value.requestId, {
            stdout: "from selected agent\n",
            stderr: "",
            exitCode: 0,
            error: "",
          });
        }
      },
      close: () => {},
    };
    dispatcher.register("agent-a", agentA);
    dispatcher.register("agent-b", agentB);
    const app = makeApp(dispatcher, shellExecRegistry);

    const created = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-b",
        agentId: "agent-b",
        remoteUser: "me",
        authMethod: "key",
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };

    const exec = await app.request(`/api/terminal/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "pwd\n" }),
    });

    expect(exec.status).toBe(200);
    expect(agentAPushes).toBe(0);
    expect(agentBPushes).toBe(1);
    const body = (await exec.json()) as { output: string };
    expect(body.output).toContain("from selected agent");
  });

  test("create rejects when SpiceDB denies agent operate", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
      throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
    });
    const app = makeApp(new AgentDispatcher(), new ShellExecRegistry(), authz, {
      principalEmail: "bound-terminal@terminal.test",
      userEmail: "stale-token-terminal@terminal.test",
    });

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resource).toEqual({ type: "agent", id: "agent-a" });
    expect(calls[0]?.permission).toBe("operate");
    expect(calls[0]?.subject.id).toBe("user-terminal-admin");
    expect(calls[0]?.actorEmail).toBe("bound-terminal@terminal.test");
    expect(calls[0]?.context?.source).toBe("terminal-session-create");
  });

  test("create degraded fallback does not trust JWT platform_admin without a bound role", async () => {
    const fallbackDecisions: boolean[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (_check: AuthzCheck, isPlatformAdmin: boolean) => {
        fallbackDecisions.push(isPlatformAdmin);
      },
      shadowCheck: async () => undefined,
    } as unknown as AuthzService;
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const app = makeApp(dispatcher, new ShellExecRegistry(), authz, {
      principalRole: null,
    });

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(201);
    expect(fallbackDecisions).toEqual([false]);
  });

  test("create rejects after SpiceDB allows when the agent is offline", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
    });
    const app = makeApp(new AgentDispatcher(), new ShellExecRegistry(), authz);

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context?.source).toBe("terminal-session-create");
  });

  test("create fails closed in shadow mode without a canonical principal", async () => {
    const calls: ShadowCheckInput[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (check: ShadowCheckInput) => {
        calls.push(check);
        return check.localAllowed ?? false;
      },
      requirePermission: async () => undefined,
    } as unknown as AuthzService;
    const app = makeApp(new AgentDispatcher(), new ShellExecRegistry(), authz, {
      principalUserId: null,
    });

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("exec rejects when SpiceDB denies agent operate after session creation", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
      if (check.context?.source === "terminal-exec") {
        throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
      }
    });
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const app = makeApp(dispatcher, new ShellExecRegistry(), authz, {
      principalEmail: "bound-terminal@terminal.test",
      userEmail: "stale-token-terminal@terminal.test",
    });
    const created = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };

    const exec = await app.request(`/api/terminal/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "pwd\n" }),
    });

    expect(exec.status).toBe(403);
    expect(calls.map((check) => check.context?.source)).toEqual([
      "terminal-session-create",
      "terminal-exec",
    ]);
    expect(calls.map((check) => check.actorEmail)).toEqual([
      "bound-terminal@terminal.test",
      "bound-terminal@terminal.test",
    ]);
  });

  test("exec rejects after SpiceDB allows when the agent disconnected", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
    });
    const dispatcher = new AgentDispatcher();
    const channel = noopChannel();
    dispatcher.register("agent-a", channel);
    const app = makeApp(dispatcher, new ShellExecRegistry(), authz);
    const created = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    dispatcher.unregister("agent-a", channel);

    const exec = await app.request(`/api/terminal/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "pwd\n" }),
    });

    expect(exec.status).toBe(503);
    expect(calls.map((check) => check.context?.source)).toEqual([
      "terminal-session-create",
      "terminal-exec",
    ]);
  });

  test("off mode denies an ordinary user before creating a command session", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const app = makeApp(dispatcher, new ShellExecRegistry(), undefined, {
      principalRole: "user",
      principalOrgId: "provider-terminal",
      principalOrgIds: ["provider-terminal"],
    });

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(404);
  });

  test("off mode allows only an administrator of the Agent provider organization", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const matching = makeApp(dispatcher, new ShellExecRegistry(), undefined, {
      principalRole: "org_admin",
      principalOrgId: "provider-terminal",
      principalOrgIds: ["provider-terminal"],
    });
    const other = makeApp(dispatcher, new ShellExecRegistry(), undefined, {
      principalRole: "org_admin",
      principalOrgId: "other-provider",
      principalOrgIds: ["other-provider"],
    });
    const body = JSON.stringify({
      siteId: "site-a",
      agentId: "agent-a",
      remoteUser: "me",
      authMethod: "key",
    });

    const allowed = await matching.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const denied = await other.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(allowed.status).toBe(201);
    expect(denied.status).toBe(404);
  });

  test("shadow mode records and enforces the local provider decision", async () => {
    const calls: ShadowCheckInput[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (check: ShadowCheckInput) => {
        calls.push(check);
        return check.localAllowed ?? false;
      },
      requirePermission: async () => undefined,
    } as unknown as AuthzService;
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const app = makeApp(dispatcher, new ShellExecRegistry(), authz, {
      principalRole: "org_admin",
      principalOrgId: "other-provider",
      principalOrgIds: ["other-provider"],
    });

    const res = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.localAllowed).toBe(false);
  });

  test("exec timeout returns AGENT_OFFLINE instead of simulated output", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-a", noopChannel());
    const app = makeApp(dispatcher, new ShellExecRegistry(), undefined, {
      shellExecTimeoutMs: 5,
    });
    const created = await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-a",
        agentId: "agent-a",
        remoteUser: "me",
        authMethod: "key",
      }),
    });
    const session = (await created.json()) as { id: string };

    const exec = await app.request(`/api/terminal/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "pwd\n" }),
    });
    const response = (await exec.json()) as {
      error?: { code?: string; details?: { reason?: string } };
    };

    expect(exec.status).toBe(504);
    expect(response.error?.code).toBe("AGENT_OFFLINE");
    expect(response.error?.details?.reason).toBe("TERMINAL_EXEC_TIMEOUT");
  });
});
