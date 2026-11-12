import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceLease, startMaintenanceControl } from "./maintenance-control";

const first = "a".repeat(32);
const second = "b".repeat(32);

test("busy does not retain a gate and an old lease cannot resume a new owner", async () => {
  const resumed: string[] = [];
  let idle = false;
  const control = new MaintenanceLease({
    drain: async () => idle,
    resume: (lease) => {
      resumed.push(lease);
    },
  });
  expect((await control.request({ action: "drain", lease: first })).reason).toBe(
    "MAINTENANCE_BUSY",
  );
  idle = true;
  expect((await control.request({ action: "drain", lease: second })).ok).toBe(true);
  expect((await control.request({ action: "resume", lease: first })).ok).toBe(false);
  expect(resumed).toEqual([first]);
  expect((await control.request({ action: "drain", lease: second })).ok).toBe(true);
  expect((await control.request({ action: "resume", lease: second })).ok).toBe(true);
  expect(resumed).toEqual([first, second]);
  control.close();
});

test("lease expiry releases pending drains and a late result cannot grant expired permission", async () => {
  const pending = Promise.withResolvers<boolean>();
  const resumed: string[] = [];
  const control = new MaintenanceLease(
    {
      drain: () => pending.promise,
      resume: (lease) => {
        resumed.push(lease);
      },
    },
    10,
  );
  const response = control.request({ action: "drain", lease: first });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(resumed).toEqual([first]);
  pending.resolve(true);
  expect((await response).reason).toBe("MAINTENANCE_EXPIRED");
  control.close();
});

test("private Unix socket accepts newline requests, rejects invalid leases, and cleans its path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kq-maintenance-")));
  await chmod(root, 0o700);
  const path = join(root, "maintenance.sock");
  let drains = 0;
  const server = await startMaintenanceControl(path, {
    drain: async () => {
      drains += 1;
      return true;
    },
    resume: () => {},
  });
  const request = (value: unknown): Promise<{ ok: boolean; lease: string; reason: string }> =>
    new Promise((resolve, reject) => {
      const client = createConnection(path);
      client.once("connect", () => client.write(`${JSON.stringify(value)}\n`));
      client.once("data", (data) => {
        client.end();
        resolve(JSON.parse(data.toString()));
      });
      client.once("error", reject);
    });
  try {
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await request({ action: "drain", lease: "invalid" })).reason).toBe(
      "MAINTENANCE_INVALID",
    );
    expect(drains).toBe(0);
    expect((await request({ action: "drain", lease: first })).ok).toBe(true);
    expect((await request({ action: "resume", lease: second })).ok).toBe(false);
    expect((await request({ action: "resume", lease: first })).ok).toBe(true);
  } finally {
    await server.close();
    expect(await lstat(path).catch(() => undefined)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance socket refuses a shared parent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kq-maintenance-mode-")));
  try {
    await chmod(root, 0o755);
    await expect(
      startMaintenanceControl(join(root, "maintenance.sock"), {
        drain: async () => true,
        resume: () => {},
      }),
    ).rejects.toThrow("PARENT_PRIVATE_REQUIRED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
