import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler, createNotFoundHandler } from "./error-handler";

const testLogger = pino({ level: "silent" });

// ISSUE-012 regression: Hono's default notFound returned text/plain
// "404 Not Found" for unknown registry routes, breaking the same
// envelope contract that ISSUE-005/010/011 enforced everywhere else.
describe("registry createNotFoundHandler", () => {
  function makeApp() {
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.notFound(createNotFoundHandler());
    app.get("/api/exists", (c) => c.json({ ok: true }));
    return app;
  }

  test("unknown route → 404 NOT_FOUND JSON envelope", async () => {
    const res = await makeApp().request("/api/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");
  });

  test("registered route still works", async () => {
    const res = await makeApp().request("/api/exists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
