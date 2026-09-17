import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { healthRoutes } from "./health";

describe("GET /health", () => {
  const app = new Hono().route("/api", healthRoutes);

  test("returns 200 with status ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });
});
