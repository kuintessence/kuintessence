import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "./principal-binder";

/** The caller pins the expected context; the header never selects an organization. */
export const federationOrganizationContext: MiddlewareHandler = async (c, next) => {
  const expected = c.req.header("x-kq-active-organization");
  if (expected !== undefined) {
    c.header("cache-control", "no-store");
    if (!z.uuid().safeParse(expected).success)
      return c.json({ error: { code: "INVALID_ORGANIZATION_CONTEXT" } }, 400);
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (principal?.orgId !== expected)
      return c.json({ error: { code: "ORGANIZATION_CONTEXT_CHANGED" } }, 409);
  }
  await next();
};
