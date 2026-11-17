import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentUpdateController } from "./agent-update";

test("remote requests are durable, idempotent, opt-in and confirmed only by the target process", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-update-"));
  const path = join(root, "update.json");
  const id = crypto.randomUUID();
  const release = "a".repeat(64);
  try {
    const disabled = new AgentUpdateController(path, false, release);
    await disabled.receive(id, release);
    expect((await disabled.report())?.state).toBe("disabled");
    const controller = new AgentUpdateController(path, true, "b".repeat(64));
    const next = crypto.randomUUID();
    await controller.receive(next, release);
    await controller.receive(next, release);
    await expect(controller.receive(next, "c".repeat(64))).rejects.toThrow("changed");
    await expect(controller.receive(crypto.randomUUID(), release)).rejects.toThrow("pending");
    const pending = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...pending, state: "restarting" }));
    expect((await controller.report())?.state).toBe("restarting");
    expect(await controller.confirm()).toBe(false);
    const target = new AgentUpdateController(path, true, release);
    expect((await target.report())?.state).toBe("restarting");
    expect(await target.confirm()).toBe(true);
    expect(await target.confirm()).toBe(false);
    expect((await target.report())?.state).toBe("succeeded");
    expect(JSON.parse(await readFile(path, "utf8")).state).toBe("succeeded");
    await target.receive(next, release);
    expect((await target.report())?.state).toBe("succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe request files and unvalidated release input cannot trigger an update", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-update-"));
  const path = join(root, "request.json");
  const controller = new AgentUpdateController(path, true, undefined);
  try {
    await expect(controller.receive(crypto.randomUUID(), "../../agent")).rejects.toThrow();
    await writeFile(path, "{}", { mode: 0o644 });
    await expect(controller.report()).rejects.toThrow("Unsafe");
    await chmod(path, 0o600);
    await expect(controller.report()).rejects.toThrow();
    await rm(path);
    await symlink(join(root, "missing"), path);
    await expect(controller.receive(crypto.randomUUID(), "a".repeat(64))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
