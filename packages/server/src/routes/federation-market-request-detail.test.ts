import { expect, test } from "bun:test";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import pino from "pino";
import type { FederationCommercialAgreementService } from "../federation/commercial-agreements";
import type { FederationCommercialSubmissionService } from "../federation/commercial-submissions";
import type { FederationMarketRequestService } from "../federation/market-requests";
import type { FederationActor } from "../federation/permissions";
import { createErrorHandler } from "../middleware/error-handler";
import { createFederationCommercialRoutes } from "./federation-commercial";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: uuid(1), orgId: uuid(2) },
  revision = uuid(3),
  reservation = uuid(4);
const path = `/federation/commercial-agreements/${revision}/market-requests/${reservation}`;
function fixture({ human = true, automation = false, denied = false, missing = false } = {}) {
  const calls: { actor: FederationActor; revisionId: string; reservationId: string }[] = [];
  const service = {
    get: async (actor: FederationActor, revisionId: string, reservationId: string) => {
      calls.push({ actor, revisionId, reservationId });
      if (denied) throw new FederationError("POLICY_DENIED");
      if (missing) throw new FederationError("ASSET_UNAVAILABLE");
      return { reservationId, request: { private: "visible only after service authorization" } };
    },
  } as unknown as FederationMarketRequestService;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    if (human) c.set("principal" as never, actor as never);
    if (automation) c.set("automation" as never, true as never);
    await next();
  });
  app.route(
    "/",
    createFederationCommercialRoutes(
      {} as FederationCommercialAgreementService,
      {} as FederationCommercialSubmissionService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    ),
  );
  return { app, calls };
}
test("private request detail passes the session organization and exact identifiers without caching", async () => {
  const { app, calls } = fixture();
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toEqual([{ actor, revisionId: revision, reservationId: reservation }]);
  expect(await response.json()).toMatchObject({ data: { reservationId: reservation } });
});
test("private request detail requires a human and service authorization", async () => {
  for (const input of [{ human: false }, { automation: true }, { denied: true }]) {
    const { app, calls } = fixture(input);
    const response = await app.request(path);
    expect(response.status).toBe(403);
    expect(calls.length).toBe(input.denied ? 1 : 0);
    expect(await response.text()).not.toContain("visible only");
  }
});
test("private request detail preserves the missing-operation contract and validates identifiers", async () => {
  const { app, calls } = fixture({ missing: true });
  const response = await app.request(path);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "ASSET_UNAVAILABLE" } });
  expect((await app.request(path.replace(reservation, "invalid"))).status).toBe(400);
  expect(calls).toHaveLength(1);
});
