import { afterAll, describe, expect, test } from "bun:test";
import { createPgDb, jobs, users } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";

/**
 * E2E Smoke Test — exercises the Server HTTP API end-to-end.
 *
 * Requires a running Server instance (SERVER_URL env var, default http://localhost:3000)
 * and a reachable PostgreSQL database (DATABASE_URL env var).
 *
 * The Agent is NOT required — jobs stay in "pending" state (no dispatcher running).
 *
 * Automatically skipped when no Server is reachable (so `bun run test:e2e` stays
 * green in environments where only the fixture-based tests are intended to run).
 *
 * Run with:
 *   bun run test:e2e
 * Or:
 *   SERVER_URL=http://localhost:3000 DATABASE_URL=postgres://... bun test test/e2e/smoke.test.ts
 */

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const TEST_EMAIL = "smoke-e2e@kuintessence.test";

/** true when Server is NOT reachable — used to skip the suite gracefully */
let serverUnreachable = false;
try {
  const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) serverUnreachable = true;
} catch {
  serverUnreachable = true;
}

const testIf = serverUnreachable ? test.skip : test;

describe("E2E Smoke Test (requires Server running on SERVER_URL)", () => {
  let token: string;
  let jobId: string;
  const db = createPgDb(TEST_DB_URL);

  afterAll(async () => {
    if (serverUnreachable) return;
    if (jobId) {
      await db.delete(jobs).where(eq(jobs.id, jobId));
    }
    await db.delete(jobs).where(like(jobs.name, "smoke-e2e-%"));
    await db.delete(users).where(eq(users.email, TEST_EMAIL));
  });

  testIf("step 1: health check returns 200", async () => {
    const res = await fetch(`${SERVER_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  testIf("step 2: dev login returns JWT", async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, role: "user" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number };
    expect(body.token).toBeDefined();
    expect(body.expiresIn).toBe(900);
    token = body.token;
  });

  testIf("step 3: protected route rejects request without token", async () => {
    const res = await fetch(`${SERVER_URL}/api/jobs`);
    expect(res.status).toBe(401);
  });

  testIf("step 4: submit job", async () => {
    const res = await fetch(`${SERVER_URL}/api/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: "smoke-e2e-job",
        command: "echo hello world",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.name).toBe("smoke-e2e-job");
    jobId = body.id;
  });

  const waitFor = async <T>(
    fn: () => Promise<{ ok: boolean; value?: T }>,
    maxRetries = 25,
    waitMs = 200,
  ): Promise<T> => {
    for (let i = 0; i < maxRetries; i++) {
      const result = await fn();
      if (result.ok && result.value !== undefined) {
        return result.value;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const result = await fn();
    if (result.ok && result.value !== undefined) {
      return result.value;
    }
    throw new Error("Condition not met within retry window");
  };

  testIf("step 5: get job status by id", async () => {
    const body = await waitFor(async () => {
      const res = await fetch(`${SERVER_URL}/api/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        return { ok: false };
      }
      return {
        ok: true,
        value: (await res.json()) as { id: string; name: string },
      };
    });
    expect(body.id).toBe(jobId);
    expect(body.name).toBe("smoke-e2e-job");
  });

  testIf("step 6: list jobs includes the new job", async () => {
    const body = await waitFor(async () => {
      const res = await fetch(`${SERVER_URL}/api/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        return { ok: false };
      }
      const payload = (await res.json()) as { jobs: Array<{ id: string }> };
      return {
        ok: payload.jobs.some((j) => j.id === jobId),
        value: payload,
      };
    });
    expect(body.jobs.some((j) => j.id === jobId)).toBe(true);
  });

  testIf("step 7: list agents returns array", async () => {
    const res = await fetch(`${SERVER_URL}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<unknown> };
    expect(body.agents).toBeInstanceOf(Array);
  });

  testIf("step 8: cancel job transitions to cancelled", async () => {
    const body = await waitFor(async () => {
      const res = await fetch(`${SERVER_URL}/api/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) {
        return { ok: false };
      }
      return {
        ok: true,
        value: (await res.json()) as { status: string },
      };
    });
    expect(body.status).toBe("cancelled");
  });

  testIf("step 9: GET /jobs/:id for unknown returns 404", async () => {
    const res = await fetch(`${SERVER_URL}/api/jobs/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  testIf("step 10: invalid login email returns 400", async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  testIf("step 11: invalid role returns 400", async () => {
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "any@valid.com", role: "not-a-role" }),
    });
    expect(res.status).toBe(400);
  });
});
