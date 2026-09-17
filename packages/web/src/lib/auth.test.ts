import { afterEach, describe, expect, test } from "vitest";
import {
  AUTH_STATE_CHANGED_EVENT,
  clearAuth,
  clearServerAuthSession,
  getAuthState,
  setAuth,
} from "./auth";

afterEach(() => clearAuth());

describe("auth state", () => {
  test("returns unauthenticated when no browser session exists", () => {
    expect(getAuthState()).toEqual({
      isAuthenticated: false,
      email: null,
      role: null,
      expiresAt: null,
      revision: null,
    });
  });

  test("setAuth stores token, email, role, and expiresAt", () => {
    const before = Date.now();
    setAuth({ token: "tok-123", email: "user@test.com", expiresIn: 900, role: "user" });
    const s = getAuthState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.email).toBe("user@test.com");
    expect(s.role).toBe("user");
    expect(s.revision).not.toBeNull();
    expect(s.expiresAt).not.toBeNull();
    if (s.expiresAt !== null) {
      expect(s.expiresAt).toBeGreaterThanOrEqual(before + 900_000 - 1000);
      expect(s.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000 + 1000);
    }
  });

  test("setAuth can store cookie session metadata without a browser-readable token", () => {
    setAuth({ email: "user@test.com", expiresIn: 900, role: "user" });
    const s = getAuthState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.email).toBe("user@test.com");
    expect(s.role).toBe("user");
    expect(localStorage.getItem("kq_token")).toBeNull();
  });

  test("setAuth clears a stale role when the caller has not resolved one", () => {
    setAuth({ email: "admin@test.com", expiresIn: 900, role: "platform_admin" });
    setAuth({ email: "user@test.com", expiresIn: 900 });
    const s = getAuthState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.email).toBe("user@test.com");
    expect(s.role).toBeNull();
  });

  test("setAuth removes an expired browser-readable token after cookie refresh", () => {
    setAuth({ token: "expired", email: "user@test.com", expiresIn: 1, role: "user" });
    setAuth({ token: null, email: "user@test.com", expiresIn: 900, role: "user" });
    expect(localStorage.getItem("kq_token")).toBeNull();
    expect(getAuthState().isAuthenticated).toBe(true);
  });

  test("expired session metadata is not treated as authenticated", () => {
    setAuth({ email: "user@test.com", expiresIn: -1, role: "user" });
    expect(getAuthState().isAuthenticated).toBe(false);
  });

  test("clearAuth wipes everything", () => {
    setAuth({ token: "tok-123", email: "user@test.com", expiresIn: 900, role: "user" });
    clearAuth();
    const s = getAuthState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.email).toBeNull();
    expect(s.role).toBeNull();
    expect(s.expiresAt).toBeNull();
    expect(s.revision).toBeNull();
  });

  test("creates a new cache identity for a repeated login with the same email", () => {
    setAuth({ email: "user@test.com", expiresIn: 900, role: "platform_admin" });
    const previous = getAuthState().revision;

    setAuth({ email: "user@test.com", expiresIn: 900, role: "user" });

    expect(getAuthState().revision).not.toBe(previous);
  });

  test("notifies mounted application shells when auth state changes", () => {
    let changes = 0;
    const listener = () => {
      changes += 1;
    };
    window.addEventListener(AUTH_STATE_CHANGED_EVENT, listener);
    try {
      setAuth({ email: "user@test.com", expiresIn: 900, role: "user" });
      clearAuth();
    } finally {
      window.removeEventListener(AUTH_STATE_CHANGED_EVENT, listener);
    }
    expect(changes).toBe(2);
  });

  test("clearServerAuthSession clears the HttpOnly cookie through the Server logout route", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;
    try {
      await clearServerAuthSession();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(String(calls[0]?.input)).toBe("/platform/api/auth/logout");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });
});
