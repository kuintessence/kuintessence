import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSiteUpdate } from "./site-operations";

test("site updates expose only bounded private status and no arbitrary local fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-status-"));
  try {
    await mkdir(join(root, "state"));
    const path = join(root, "status.json");
    await writeFile(
      path,
      JSON.stringify({ phase: "staged", time: 123, release: "a".repeat(64), privateUrl: "secret" }),
      { mode: 0o600 },
    );
    expect(await readSiteUpdate(join(root, "state", "agent.db"))).toEqual({
      phase: "staged",
      checkedAt: 123000,
      release: "a".repeat(64),
    });
    await chmod(path, 0o644);
    expect(await readSiteUpdate(join(root, "state", "agent.db"))).toEqual({ phase: "unknown" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a FIFO update status cannot block the heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-status-fifo-"));
  try {
    await mkdir(join(root, "state"));
    const fifo = Bun.spawn(["mkfifo", join(root, "status.json")], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await fifo.exited).toBe(0);
    expect(await readSiteUpdate(join(root, "state", "agent.db"))).toEqual({ phase: "unknown" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
