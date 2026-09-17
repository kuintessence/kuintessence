import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import pino from "pino";
import { AUTH_SESSION_COOKIE } from "../auth/session-cookie";
import { signToken } from "../services/auth";
import { authMiddleware } from "./auth";
import { createErrorHandler } from "./error-handler";

const SECRET = "test-secret-at-least-32-chars-long-aaa!";
const testLogger = pino({ level: "silent" });

function makeApp() {
  const app = new Hono();
  app.onError(createErrorHandler(testLogger));
  app.use("*", authMiddleware(SECRET));
  app.get("/protected", (c) => c.json({ user: c.get("user") }));
  app.post("/protected", (c) => c.json({ user: c.get("user") }));
  return app;
}

describe("authMiddleware", () => {
  test("401 when Authorization header is missing", async () => {
    const res = await makeApp().request("/protected");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("401 when scheme is not Bearer", async () => {
    const res = await makeApp().request("/protected", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  test("401 when token is malformed", async () => {
    const res = await makeApp().request("/protected", {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("401 when token is expired", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, -1);
    const res = await makeApp().request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("200 and sets c.var.user when token is valid", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { sub: string; role: string; email: string } };
    expect(body.user.sub).toBe("u1");
    expect(body.user.role).toBe("user");
    expect(body.user.email).toBe("u1@test.com");
  });

  test("200 when valid token is provided through the auth session cookie", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("/protected", {
      headers: { Cookie: `${AUTH_SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { sub: string; role: string; email: string } };
    expect(body.user.email).toBe("u1@test.com");
  });

  test("allows same-origin unsafe methods when using the auth session cookie", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://localhost/protected", {
      method: "POST",
      headers: {
        Cookie: `${AUTH_SESSION_COOKIE}=${token}`,
        Origin: "http://localhost",
      },
    });
    expect(res.status).toBe(200);
  });

  test("allows same-origin unsafe cookie requests behind a TLS reverse proxy", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://internal-server/protected", {
      method: "POST",
      headers: {
        Cookie: `${AUTH_SESSION_COOKIE}=${token}`,
        Host: "internal-server",
        Origin: "https://server.example.com",
        "X-Forwarded-Host": "server.example.com",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(res.status).toBe(200);
  });

  test("allows browser same-origin metadata when a dev proxy rewrites the target origin", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://internal-server/protected", {
      method: "POST",
      headers: {
        Cookie: `${AUTH_SESSION_COOKIE}=${token}`,
        Host: "internal-server",
        Origin: "http://localhost:15173",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(res.status).toBe(200);
  });

  test("rejects cross-origin unsafe methods when using the auth session cookie", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://localhost/protected", {
      method: "POST",
      headers: {
        Cookie: `${AUTH_SESSION_COOKIE}=${token}`,
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });

  test("rejects cross-site fetch metadata when using the auth session cookie", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://localhost/protected", {
      method: "POST",
      headers: {
        Cookie: `${AUTH_SESSION_COOKIE}=${token}`,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(res.status).toBe(403);
  });

  test("does not apply cookie CSRF checks to Bearer clients", async () => {
    const token = await signToken({ sub: "u1", role: "user", email: "u1@test.com" }, SECRET, 3600);
    const res = await makeApp().request("http://localhost/protected", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://external-client.example",
      },
    });
    expect(res.status).toBe(200);
  });
});
