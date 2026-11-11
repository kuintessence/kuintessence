import { expect, test } from "bun:test";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import pino from "pino";
import type { FederationMarketService } from "../federation/market";
import type { FederationActor } from "../federation/permissions";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationMarketRoutes } from "./federation-market";

const actor = {
  userId: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
};
const site = "00000000-0000-4000-8000-000000000003";
function fixture({ human = true, automation = false, granted = true } = {}) {
  const calls: FederationActor[] = [];
  const service = {
    context: async (request: FederationActor) => {
      calls.push(request);
      if (!granted) throw new FederationError("POLICY_DENIED");
      return { localSiteId: site, enabled: false };
    },
  } as unknown as FederationMarketService;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    if (human) c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route("/api", createFederationMarketRoutes(service));
  return { app, calls };
}
test("market context binds the human organization and remains available without a ledger", async () => {
  const { app, calls } = fixture();
  const response = await app.request("/api/federation/market/context");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    success: true,
    data: { localSiteId: site, enabled: false },
  });
  expect(calls).toEqual([actor]);
});
test("market context rejects missing people, automation and denied market readers", async () => {
  for (const input of [{ human: false }, { automation: true }, { granted: false }]) {
    const { app, calls } = fixture(input);
    expect((await app.request("/api/federation/market/context")).status).toBe(403);
    expect(calls.length).toBe(input.granted === false ? 1 : 0);
  }
});
