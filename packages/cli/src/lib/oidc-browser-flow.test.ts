// OIDC browser flow tests — drive callback + exchange without a real browser.
import { describe, expect, it } from "bun:test";
import { runOidcBrowserFlow } from "./oidc-browser-flow";

describe("runOidcBrowserFlow", () => {
  it("captures the callback and exchanges the code", async () => {
    let openedUrl: string | undefined;
    let exchangeUrl: string | undefined;
    let exchangeBody: unknown;
    const fakeFetch = async (url: string | URL, init?: RequestInit) => {
      exchangeUrl = String(url);
      exchangeBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          accessToken: "tok-abc",
          expiresAt: "2026-12-31T00:00:00Z",
          principal: { sub: "u-1", email: "alice@example.com" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const openBrowser = async (url: string) => {
      openedUrl = url;
      // Extract redirect_uri and state, then synthesize the callback hit.
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri");
      const state = u.searchParams.get("state");
      // Hit the local callback shortly after.
      setTimeout(() => {
        fetch(`${redirect}?code=test-code&state=${state}`).catch(() => {});
      }, 20);
    };
    const r = await runOidcBrowserFlow("http://server.test/platform/", {
      openBrowser,
      fetch: fakeFetch,
      timeoutMs: 5_000,
    });
    expect(r.accessToken).toBe("tok-abc");
    expect(r.principal?.email).toBe("alice@example.com");
    expect(new URL(openedUrl ?? "http://invalid").pathname).toBe("/platform/api/auth/oidc/login");
    expect(exchangeUrl).toBe("http://server.test/platform/api/auth/oidc/exchange");
    expect(exchangeBody).toMatchObject({ code: "test-code" });
  });

  it("rejects on state mismatch (CSRF)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ accessToken: "x" }), { status: 200 });
    const openBrowser = async (url: string) => {
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri");
      // Wrong state → must throw.
      setTimeout(() => {
        fetch(`${redirect}?code=test-code&state=NOT-THE-STATE`).catch(() => {});
      }, 20);
    };
    await expect(
      runOidcBrowserFlow("http://server.test", {
        openBrowser,
        fetch: fakeFetch,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow("state mismatch");
  });

  it("times out if no callback arrives", async () => {
    const fakeFetch = async () => new Response("", { status: 200 });
    await expect(
      runOidcBrowserFlow("http://server.test", {
        openBrowser: async () => {},
        fetch: fakeFetch,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("timed out");
  });
});
