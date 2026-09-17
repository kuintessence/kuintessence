import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, jobs, orgs, type PgDb, users } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { EventBus, type JobStatusChangedEvent } from "../events/event-bus";
import { JobService } from "./job-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

/**
 * when a status transition is persisted, the JobService must publish
 * a JobStatusChanged event to the in-process bus so the WS layer can fan it
 * out to subscribed clients.
 *
 * These tests pin the *publish* contract; the bus's own unit tests cover
 * delivery semantics, and the WS-route tests cover RBAC.
 */
describe("JobService → EventBus publishing", () => {
  let db: PgDb;
  let bus: EventBus;
  let service: JobService;
  let testUserId: string;
  let testOrgId: string;
  const testJobIds: string[] = [];

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    bus = new EventBus();
    service = new JobService(db, bus);

    const [org] = await db.insert(orgs).values({ name: "test-org-jobsvc-evt" }).returning();
    if (!org) throw new Error("create org failed");
    testOrgId = org.id;

    const [user] = await db
      .insert(users)
      .values({
        email: "jobsvc-evt-test@kuintessence.test",
        role: "user",
        orgId: testOrgId,
      })
      .returning();
    if (!user) throw new Error("create user failed");
    testUserId = user.id;
  });

  afterAll(async () => {
    for (const id of testJobIds) {
      await db.delete(jobs).where(eq(jobs.id, id));
    }
    await db.delete(jobs).where(like(jobs.name, "test-job-svc-evt-%"));
    await db.delete(users).where(eq(users.email, "jobsvc-evt-test@kuintessence.test"));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("updateStatus → publishes JobStatusChangedEvent on the bus", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-evt-running",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    const received: JobStatusChangedEvent[] = [];
    const unsub = bus.subscribeJob(job.id, (e) => received.push(e));

    await service.updateStatus(job.id, "running", "slurm-evt-1");

    expect(received).toHaveLength(1);
    expect(received[0]?.jobId).toBe(job.id);
    expect(received[0]?.status).toBe("running");
    expect(received[0]?.schedulerJobId).toBe("slurm-evt-1");
    unsub();
  });

  test("updateStatus on terminal status also publishes", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-evt-completed",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    const received: JobStatusChangedEvent[] = [];
    const unsub = bus.subscribeJob(job.id, (e) => received.push(e));

    await service.updateStatus(job.id, "running");
    await service.updateStatus(job.id, "completed");

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.status)).toEqual(["running", "completed"]);
    unsub();
  });

  test("subscribers for *other* jobs receive nothing", async () => {
    const a = await service.submit(
      {
        name: "test-job-svc-evt-isolation-a",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    const b = await service.submit(
      {
        name: "test-job-svc-evt-isolation-b",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(a.id, b.id);

    const eventsForA: JobStatusChangedEvent[] = [];
    bus.subscribeJob(a.id, (e) => eventsForA.push(e));

    await service.updateStatus(b.id, "running");

    expect(eventsForA).toHaveLength(0);
  });

  test("works without a bus (back-compat: optional dependency)", async () => {
    const noBusService = new JobService(db);
    const job = await noBusService.submit(
      {
        name: "test-job-svc-evt-nobus",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    const updated = await noBusService.updateStatus(job.id, "running");
    expect(updated.status).toBe("running");
  });
});
