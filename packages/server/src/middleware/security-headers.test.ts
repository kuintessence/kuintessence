import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "./security-headers";

describe("securityHeaders", () => {
  function app() {
    const a = new Hono();
    a.use("*", securityHeaders());
    a.get("/x", (c) => c.json({ ok: true }));
    return a;
  }

  test("sets the CORS-safe baseline headers on responses", async () => {
    const res = await app().request("/x");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("does NOT set CORS-affecting headers (deferred to tbd #16)", async () => {
    const res = await app().request("/x");
    // These interact with the cross-origin SPA→API setup; must stay unset here.
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("sets Content-Security-Policy when explicitly configured", async () => {
    const a = new Hono();
    const policy = "default-src 'self'";
    a.use("*", securityHeaders({ contentSecurityPolicy: policy }));
    a.get("/x", (c) => c.json({ ok: true }));
    const res = await a.request("/x");
    expect(res.headers.get("Content-Security-Policy")).toBe(policy);
  });
});
