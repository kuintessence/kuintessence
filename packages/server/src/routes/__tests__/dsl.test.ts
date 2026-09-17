// DSL JSON Schema route tests.
//
// These tests pin the public schema endpoint contract that external editors
// (Monaco YAML, VS Code YAML) and CI lint tools rely on:
//   - status, content-type, cache control headers,
//   - ETag is stable across calls,
//   - If-None-Match honors → 304 with no body,
//   - the body is a valid JSON Schema document with the expected $id.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dslRoutes } from "../dsl";

function makeApp() {
  return new Hono().route("/api", dslRoutes);
}

describe("GET /api/dsl/schema/workflow", () => {
  test("returns 200 with JSON Schema body and the right headers", async () => {
    const app = makeApp();
    const res = await app.request("/api/dsl/schema/workflow");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/schema+json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.$id).toBe("https://platform.local/schemas/workflow.json");
    expect(body.type).toBe("object");
    expect(body.properties).toBeDefined();
  });

  test("ETag is stable across calls", async () => {
    const app = makeApp();
    const a = await app.request("/api/dsl/schema/workflow");
    const b = await app.request("/api/dsl/schema/workflow");
    expect(a.headers.get("ETag")).toBe(b.headers.get("ETag"));
  });

  test("returns 304 when If-None-Match matches the current ETag", async () => {
    const app = makeApp();
    const initial = await app.request("/api/dsl/schema/workflow");
    const etag = initial.headers.get("ETag");
    expect(etag).toBeTruthy();
    const cached = await app.request("/api/dsl/schema/workflow", {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("ETag")).toBe(etag);
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=3600");
    // 304 must not carry a body.
    const body = await cached.text();
    expect(body).toBe("");
  });

  test("returns 200 + body when If-None-Match does not match", async () => {
    const app = makeApp();
    const res = await app.request("/api/dsl/schema/workflow", {
      headers: { "If-None-Match": '"deadbeef"' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.$id).toBeDefined();
  });
});
