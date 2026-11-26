import { expect, test } from "bun:test";
import {
  createPgDb,
  meteringCronPeriods,
  netdriveFiles,
  netdriveStorageDaily,
} from "@kuintessence/db";
import { eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createStorageRoutes } from "../routes/storage";
import { ClusterFileRootService } from "./cluster-file-root";
import { captureDailyStorage } from "./storage-metering";
import { StorageQuotaService } from "./storage-quota";

const url = process.env.DATABASE_URL;
test.skipIf(!url || !new URL(url).pathname.startsWith("/kuintessence_unit_"))(
  "daily NetDrive snapshots backfill, survive retry and serve only the caller's scope",
  async () => {
    if (!url) throw new Error("Missing unit database");
    const db = createPgDb(url);
    const peer = createPgDb(url);
    const namespace = sql.identifier(`storage_daily_${crypto.randomUUID().replaceAll("-", "")}`);
    const [owner, other] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
    const day = "2025-07-02";
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.use("*", async (c, next) => {
      c.set("principal" as never, { userId: owner, role: c.req.header("test-role") ?? "user" });
      await next();
    });
    app.route(
      "/api",
      createStorageRoutes({
        db,
        service: new StorageQuotaService(db),
        clusterFileRootService: new ClusterFileRootService(db),
      }),
    );
    const list = (params: string, admin = false) =>
      app.request(`/api/${admin ? "admin/" : ""}storage/usage/daily?${params}`, {
        headers: { "test-role": admin ? "platform_admin" : "user" },
      });
    try {
      await db.execute(sql`create schema ${namespace}`);
      for (const table of ["netdrive_files", "netdrive_storage_daily", "metering_cron_periods"]) {
        await db.execute(
          sql`create table ${namespace}.${sql.identifier(table)} (like public.${sql.identifier(table)} including all)`,
        );
      }
      for (const session of [db, peer]) await session.execute(sql`set search_path = ${namespace}`);
      const file = (ownerId: string, size: number, from: string, to: string) => ({
        ownerId,
        path: "same-path",
        storageKey: crypto.randomUUID(),
        sha256: "a".repeat(64),
        size,
        createdAt: new Date(from),
        deletedAt: new Date(to),
      });
      await db
        .insert(netdriveFiles)
        .values([
          file(owner, 10, "2025-07-01T23:00:00Z", "2025-07-02T12:00:00Z"),
          file(owner, 20, "2025-07-02T12:00:00Z", "2025-07-03T00:00:00Z"),
          file(other, 2 ** 41, "2025-07-02T00:00:00Z", "2025-07-04T00:00:00Z"),
          { ...file(other, 3, "2025-07-05T23:00:00Z", "2025-07-06T00:00:00Z"), deletedAt: null },
          file(owner, 1, "2025-07-03T00:00:00Z", "2025-07-03T00:00:00.001Z"),
        ]);
      expect(await (await list(`day=${day}`)).json()).toMatchObject({ ready: false, usage: [] });
      await db.execute(
        sql`alter table ${netdriveStorageDaily} add constraint test_failure check (byte_seconds < 0)`,
      );
      await expect(captureDailyStorage(db)).rejects.toThrow();
      expect(await db.select().from(meteringCronPeriods)).toHaveLength(0);
      await db.execute(sql`alter table ${netdriveStorageDaily} drop constraint test_failure`);
      const [privilege] = await peer.execute<{ allowed: boolean }>(
        sql`select has_parameter_privilege(current_user, 'track_activities', 'SET') as allowed`,
      );
      if (privilege?.allowed) {
        await peer.transaction(async (tx) => {
          await tx.execute(sql`set local track_activities = off`);
          await tx.execute(sql`lock table ${netdriveFiles} in row exclusive mode`);
          await captureDailyStorage(db);
          expect(await db.select().from(meteringCronPeriods)).toHaveLength(0);
        });
      }
      await Promise.all([captureDailyStorage(db), captureDailyStorage(peer)]);
      const personal = await (await list(`day=${day}&ownerId=${other}`)).json();
      expect(personal).toEqual({
        day,
        ready: true,
        usage: [{ day, ownerId: owner, byteSeconds: "1296000.000000" }],
        nextAfterOwnerId: null,
      });
      // Rebuild only the unprocessed suffix, as on restart after more than one day offline.
      await db.delete(netdriveStorageDaily).where(gt(netdriveStorageDaily.day, "2025-07-01"));
      await db
        .update(meteringCronPeriods)
        .set({ periodStart: new Date(`${day}T00:00:00Z`) })
        .where(eq(meteringCronPeriods.stage, "storage-daily"));
      await captureDailyStorage(peer);
      expect(await (await list(`day=${day}`)).json()).toEqual(personal);
      expect((await app.request(`/api/admin/storage/usage/daily?day=${day}`)).status).toBe(403);
      expect((await list("day=2025-02-30")).status).toBe(400);
      const first = await (await list(`day=${day}&limit=1`, true)).json();
      expect(first).toMatchObject({ nextAfterOwnerId: owner, usage: [{ ownerId: owner }] });
      const second = await (await list(`day=${day}&limit=1&afterOwnerId=${owner}`, true)).json();
      expect(second).toMatchObject({
        ready: true,
        usage: [{ ownerId: other, byteSeconds: `${String(2n ** 41n * 86400n)}.000000` }],
        nextAfterOwnerId: null,
      });
      expect(await (await list("day=2025-07-03")).json()).toMatchObject({
        usage: [{ byteSeconds: "0.001000" }],
      });
      expect(await (await list("day=2025-07-04")).json()).toMatchObject({ ready: true, usage: [] });
      expect(await (await list("day=2025-07-06", true)).json()).toMatchObject({
        usage: [{ ownerId: other, byteSeconds: "259200.000000" }],
      });
      expect(await (await list("day=9999-12-31")).json()).toMatchObject({
        ready: false,
        usage: [],
      });
    } finally {
      await db.execute(sql`drop schema if exists ${namespace} cascade`);
      await Promise.all([db.$client.end(), peer.$client.end()]);
    }
  },
);
