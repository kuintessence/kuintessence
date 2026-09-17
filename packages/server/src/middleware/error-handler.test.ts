import { describe, expect, test } from "bun:test";
import { zValidator } from "@hono/zod-validator";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import pino from "pino";
import { z } from "zod";
import { createErrorHandler, createNotFoundHandler } from "./error-handler";

const testLogger = pino({ level: "silent" });

// Regression coverage for ISSUE-010 — malformed JSON bodies used to bubble
// HTTPException(400) (from zValidator) and SyntaxError (from raw c.req.json)
// up to the catch-all handler and return 500 INTERNAL_ERROR. Now both map
// to 400 VALIDATION_ERROR with the standard AppError envelope.

function makeApp() {
  const app = new Hono();
  app.onError(createErrorHandler(testLogger));
  app.post("/parse", async (c) => {
    // Direct JSON parse — throws raw SyntaxError on bad bodies.
    await c.req.json();
    return c.json({ ok: true });
  });
  // Replicates the real production path: zValidator wraps SyntaxError as
  // HTTPException(400, "Malformed JSON in request body").
  app.post("/validated", zValidator("json", z.object({ email: z.string() })), (c) =>
    c.json({ ok: true }),
  );
  app.get("/throws-app-error", () => {
    throw new AppError(ErrorCode.NOT_FOUND, "thing not found", 404);
  });
  app.get("/throws-http-exception", () => {
    throw new HTTPException(401, { message: "Custom auth failure" });
  });
  app.post("/throws-zod", async (c) => {
    const body = await c.req.json();
    z.object({ spec: z.string().trim().min(1) }).parse(body);
    return c.json({ ok: true });
  });
  app.get("/throws-generic", () => {
    throw new Error("boom");
  });
  return app;
}

describe("createErrorHandler", () => {
  test("AppError → status + JSON envelope from toJSON()", async () => {
    const res = await makeApp().request("/throws-app-error");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("thing not found");
  });

  test("raw SyntaxError on c.req.json() → 400 VALIDATION_ERROR", async () => {
    const res = await makeApp().request("/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Invalid JSON body");
  });

  test("zValidator-wrapped malformed JSON → 400 VALIDATION_ERROR (was 500)", async () => {
    // This is the actual production path — zValidator catches the parse
    // error and re-throws as HTTPException(400). Was returning 500 before
    // ISSUE-010 because the handler only caught AppError.
    const res = await makeApp().request("/validated", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Malformed JSON");
  });

  test("HTTPException with custom status → maps to matching AppError code", async () => {
    const res = await makeApp().request("/throws-http-exception");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Custom auth failure");
  });

  test("direct ZodError from route parse → 400 VALIDATION_ERROR", async () => {
    const res = await makeApp().request("/throws-zod", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Too small");
  });

  test("generic Error → 500 INTERNAL_ERROR (existing behavior preserved)", async () => {
    const res = await makeApp().request("/throws-generic");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("createNotFoundHandler", () => {
  // ISSUE-012: Hono's default notFound returns text/plain "404 Not Found", which
  // breaks the AppError envelope contract. The handler must return a JSON
  // envelope so API consumers see one consistent shape on every failure path.
  function makeAppWithNotFound() {
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.notFound(createNotFoundHandler());
    app.get("/exists", (c) => c.json({ ok: true }));
    return app;
  }

  test("unknown route → 404 NOT_FOUND with JSON envelope", async () => {
    const res = await makeAppWithNotFound().request("/no-such-thing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");
  });

  test("registered route still works", async () => {
    const res = await makeAppWithNotFound().request("/exists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
