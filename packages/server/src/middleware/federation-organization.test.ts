import { expect, test } from "bun:test";
import { Hono } from "hono";
import { federationOrganizationContext } from "./federation-organization";

const orgId = "11111111-1111-4111-8111-111111111111";
for (const method of ["GET", "POST"] as const) {
  test(`federation ${method} pins context without selecting a different organization`, async () => {
    const app = new Hono();
    let active: string | null = orgId,
      calls = 0;
    app.use("*", async (c, next) => {
      c.set("principal" as never, { orgId: active } as never);
      await next();
    });
    app.use("/federation/*", federationOrganizationContext);
    app.on(method, "/federation/test", (c) => {
      calls++;
      return c.json({ ok: true });
    });
    const send = (expected?: string) =>
      app.request("/federation/test", {
        method,
        headers: expected === undefined ? {} : { "X-KQ-Active-Organization": expected },
      });
    expect((await send(orgId)).status).toBe(200);
    active = "22222222-2222-4222-8222-222222222222";
    const changed = await send(orgId);
    expect(changed.status).toBe(409);
    expect(changed.headers.get("cache-control")).toBe("no-store");
    expect((await send("invalid")).status).toBe(400);
    active = null;
    expect((await send(orgId)).status).toBe(409);
    expect(calls).toBe(1);
    expect((await send()).status).toBe(200);
    expect(calls).toBe(2);
  });
}
