import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { jsonRequest, loginSession } from "../spack-case/api";
import { managedHttpFailureCode, managedSession } from "./session";

const originalMode = process.env.KQ_PR_TEST;
beforeEach(() => {
  process.env.KQ_PR_TEST = "1";
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.KQ_PR_TEST;
  else process.env.KQ_PR_TEST = originalMode;
});

describe("long-running managed acceptance authentication", () => {
  test("renews from the advertised expiry before another request, without changing Server TTL", async () => {
    let time = 0;
    let calls = 0;
    const token = managedSession({
      now: () => time,
      login: async (origin) => {
        expect(origin).toBe("https://server:3443");
        calls++;
        return { token: `fixture-${calls}`, expiresIn: 900 };
      },
    });
    expect(await token()).toBe("fixture-1");
    time = 869_999;
    expect(await token()).toBe("fixture-1");
    expect(calls).toBe(1);
    time = 870_000;
    expect(await token()).toBe("fixture-2");
    time = 1_740_000;
    expect(await token()).toBe("fixture-3");
  });

  test("coalesces concurrent renewal and clears failed attempts", async () => {
    let calls = 0;
    let finish: ((value: { token: string; expiresIn: number }) => void) | undefined;
    const token = managedSession({
      now: () => 0,
      login: async () => {
        calls++;
        if (calls === 1) throw new Error("Fixture login rejected");
        return new Promise<{ token: string; expiresIn: number }>((resolve) => {
          finish = resolve;
        });
      },
    });
    await expect(token()).rejects.toThrow("Fixture login rejected");
    const first = token();
    const second = token();
    expect(calls).toBe(2);
    assert(finish);
    finish({ token: "fixture-renewed", expiresIn: 900 });
    expect(await Promise.all([first, second])).toEqual(["fixture-renewed", "fixture-renewed"]);
  });

  test("bounds short lifetimes and rejects a login that expired during issuance", async () => {
    let time = 0;
    let calls = 0;
    const token = managedSession({
      now: () => time,
      login: async () => ({ token: `fixture-${++calls}`, expiresIn: 60 }),
    });
    expect(await token()).toBe("fixture-1");
    time = 30_000;
    expect(await token()).toBe("fixture-2");
    const slow = managedSession({
      now: () => time,
      login: async () => {
        time += 60_000;
        return { token: "expired-fixture", expiresIn: 60 };
      },
    });
    await expect(slow()).rejects.toThrow("near expiry");
  });

  test("requires disposable mode even for a cached credential", async () => {
    const token = managedSession({
      now: () => 0,
      login: async () => ({ token: "fixture", expiresIn: 900 }),
    });
    expect(await token()).toBe("fixture");
    delete process.env.KQ_PR_TEST;
    await expect(token()).rejects.toThrow();
  });

  test("login consumes Server expiry and does not request a longer lifetime", async () => {
    const request = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.body).toBe(JSON.stringify({
        email: "scheduler-compose-seed@kuintessence.test", role: "platform_admin",
      }));
      return Response.json({ token: "fixture", expiresIn: 900 });
    });
    try {
      expect(await loginSession("https://server:3443")).toEqual({
        token: "fixture", expiresIn: 900,
      });
    } finally {
      request.mockRestore();
    }
  });

  test("each JSON request resolves its credential without replaying unauthorized mutations", async () => {
    let tokens = 0;
    let requests = 0;
    const token = async () => `fixture-${++tokens}`;
    const request = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests++;
      expect(init?.headers).toMatchObject({ Authorization: `Bearer fixture-${requests}` });
      return requests === 1 ? Response.json({ ok: true }) : new Response(null, { status: 401 });
    });
    try {
      expect(await jsonRequest("https://server:3443", token, "/workflows")).toEqual({ ok: true });
      await expect(jsonRequest("https://server:3443", token, "/workflows", {})).rejects.toThrow();
      expect(tokens).toBe(2);
      expect(requests).toBe(2);
    } finally {
      request.mockRestore();
    }
  });

  test("HTTP diagnostics expose only an allowlisted numeric status", () => {
    const error = (message: string) => new assert.AssertionError({ message });
    expect(managedHttpFailureCode(error("/workflows/fixture: HTTP 401"))).toBe("HTTP_401");
    expect(managedHttpFailureCode(error("/auth/login: HTTP 401"))).toBe("HTTP_401");
    expect(managedHttpFailureCode(error("/netdrive/files/fixture: HTTP 403"))).toBe("HTTP_403");
    expect(managedHttpFailureCode(error("/jobs/fixture/logs: HTTP 500"))).toBe("HTTP_500");
    for (const value of [
      error("private value"),
      error("/workflows: HTTP 401\nprivate token"),
      error("https://private.example: HTTP 401"),
      new Error("/workflows: HTTP 401"),
    ]) {
      expect(managedHttpFailureCode(value)).toBeUndefined();
    }
  });
});
