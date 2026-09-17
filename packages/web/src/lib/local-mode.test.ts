import { afterEach, describe, expect, test } from "vitest";
import { clearAuth, getAuthState } from "./auth";
import { ensureLocalSession } from "./local-mode";

afterEach(() => {
  clearAuth();
  window.__KQ_LOCAL__ = undefined;
});

describe("ensureLocalSession", () => {
  test("outside local mode it never creates a session", () => {
    expect(ensureLocalSession()).toBe(false);
    expect(getAuthState().isAuthenticated).toBe(false);
  });

  test("promotes the injected token into a persisted session", () => {
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:9999/api", token: "local-t" };
    expect(ensureLocalSession()).toBe(true);
    const auth = getAuthState();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.email).toBe("local");
    expect(auth.role).toBe("user");
  });

  test("is a no-op when local mode injects no token", () => {
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:9999/api" };
    expect(ensureLocalSession()).toBe(false);
    expect(getAuthState().isAuthenticated).toBe(false);
  });

  test("does not overwrite an existing authenticated session", () => {
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:9999/api", token: "local-t" };
    localStorage.setItem("kq_token", "existing");
    localStorage.setItem("kq_email", "server-user@test.com");
    expect(ensureLocalSession()).toBe(true);
    expect(getAuthState().email).toBe("server-user@test.com");
  });
});
