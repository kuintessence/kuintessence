import { createHmac } from "node:crypto";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode, RegistryRoleSchema } from "@kuintessence/shared";
import {
  checkNamespaceAccess,
  parseNamespace,
  type RegistryRole,
} from "@kuintessence/shared/registry-namespace";
import { Hono, type MiddlewareHandler } from "hono";
import { authMiddleware } from "../middleware/auth";
import { type BoundPrincipal, principalBinder } from "../middleware/principal-binder";

interface RegistryTokenOptions {
  publicOrigin: string;
  secret: string;
  issuer?: string;
  audience?: string;
  publisherRoles?: RegistryRole[];
}

export function createRegistryTokenRoutes(
  db: PgDb,
  jwtSecret: string,
  options: RegistryTokenOptions,
  authenticate: MiddlewareHandler = authMiddleware(jwtSecret, db),
  bindPrincipal: MiddlewareHandler = principalBinder(db),
) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin.replace(/\/$/, "")) {
    throw new Error("Registry public origin must be an HTTPS origin");
  }
  const app = new Hono<{ Variables: { principal: BoundPrincipal } }>();
  app.use("/registry/token", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("WWW-Authenticate", 'Basic realm="Registry: platform access token"');
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Basic ")) return c.json({ error: "invalid_credentials" }, 401);
    let decoded: string;
    try {
      decoded = atob(authorization.slice(6));
    } catch {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    if (separator < 1 || !token || token.startsWith("kqac_") || token.split(".").length !== 3) {
      return c.json({ error: "invalid_credentials" }, 401);
    }
    // The existing platform middleware enforces session revocation and service-account restrictions.
    const headers = new Headers(c.req.raw.headers);
    headers.set("Authorization", `Bearer ${token}`);
    c.req.raw = new Request(c.req.raw, { headers });
    return authenticate(c, async () => {
      const user = c.get("user");
      if (!user || (username !== user.email && username !== user.sub)) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid registry credentials", 401);
      }
      await next();
    });
  });
  app.use("/registry/token", bindPrincipal);
  app.get("/registry/token", (c) => {
    if (c.req.query("service") !== origin.host) return c.json({ error: "invalid_service" }, 400);
    // Docker requests offline_token as an optional hint; this endpoint only issues access tokens.
    if (c.req.query("grant_type") !== undefined || c.req.query("refresh_token") !== undefined)
      return c.json({ error: "unsupported_grant_type" }, 400);
    const principal = c.get("principal");
    const role = RegistryRoleSchema.safeParse(principal?.role);
    if (!principal?.userId || !role.success) return c.json({ error: "invalid_credentials" }, 401);
    const identity = { sub: principal.userId, role: role.data, orgIds: principal.orgIds };
    const access: { type: "repository"; name: string; actions: ("pull" | "push")[] }[] = [];
    try {
      for (const scope of c.req.queries("scope") ?? []) {
        for (const value of scope.split(" ").filter(Boolean)) {
          const match = /^repository:([^:]+):(pull|push)(?:,(pull|push))*$/.exec(value);
          if (!match?.[1]) return c.json({ error: "invalid_scope" }, 400);
          const name = match[1];
          if (!/^(public|org|user)\/[a-z0-9._/-]+$/.test(name) || name.includes("//"))
            return c.json({ error: "invalid_scope" }, 400);
          const ns = parseNamespace(name);
          const actions: ("pull" | "push")[] = [];
          for (const action of value.slice(value.lastIndexOf(":") + 1).split(",")) {
            const requested = action as "pull" | "push";
            checkNamespaceAccess(
              identity,
              ns,
              requested === "pull" ? "read" : "write",
              options.publisherRoles,
            );
            if (!actions.includes(requested)) actions.push(requested);
          }
          access.push({ type: "repository", name, actions });
        }
      }
    } catch {
      return c.json({ error: "denied" }, 403);
    }
    const now = Math.floor(Date.now() / 1000);
    const authorization = c.req.header("Authorization") ?? "";
    const payload: unknown = JSON.parse(
      Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString(),
    );
    const expiry =
      typeof payload === "object" && payload !== null && "exp" in payload ? payload.exp : undefined;
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= now)
      return c.json({ error: "invalid_credentials" }, 401);
    const expiresIn = Math.min(300, Math.floor(expiry - now));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...identity, access, iss: options.issuer, aud: options.audience, iat: now, exp: now + expiresIn })}`;
    const token = `${body}.${createHmac("sha256", options.secret).update(body).digest("base64url")}`;
    return c.json({
      token,
      access_token: token,
      expires_in: expiresIn,
      issued_at: new Date(now * 1000).toISOString(),
    });
  });
  return app;
}
