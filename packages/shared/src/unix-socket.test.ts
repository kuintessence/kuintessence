import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "kq-unix-startup-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "unix-socket-check.fixture.ts")],
    outdir: dir,
    target: "node",
  });
  expect(build.success).toBe(true);
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for socket compatibility tests");
  const path = join(dir, "ingress.sock");
  const command = [node, join(dir, "unix-socket-check.fixture.js"), path];
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const start = (args = command, env = process.env) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env });
    processes.push(child);
    return child;
  };
  return {
    path,
    command,
    start,
    async close() {
      for (const child of processes) child.kill("SIGKILL");
      await Promise.all(processes.map((child) => child.exited));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function ready(child: ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>) {
  const reader = child.stdout.getReader();
  try {
    return new TextDecoder().decode((await reader.read()).value).trim();
  } finally {
    reader.releaseLock();
  }
}

test.skipIf(process.platform !== "linux")(
  "Node startup lock survives child flock exit and is released by process death",
  async () => {
    const f = await fixture();
    try {
      const first = f.start([...f.command, "hold"]);
      expect(await ready(first)).toBe("locked");
      const competing = f.start();
      expect(await competing.exited).toBe(1);
      expect(await new Response(competing.stderr).text()).toContain("already in progress");
      first.kill("SIGKILL");
      await first.exited;
      const recovered = f.start();
      expect(await ready(recovered)).toBe("ready");
      expect(await (await fetch("http://localhost/", { unix: f.path })).text()).toBe("ready");
    } finally {
      await f.close();
    }
  },
  15000,
);

const canIsolateNetwork =
  process.platform === "linux" && spawnSync("unshare", ["--net", "true"]).status === 0;
test.skipIf(!canIsolateNetwork)(
  "shared volume lock prevents simultaneous starts across network namespaces",
  async () => {
    const f = await fixture();
    try {
      const first = f.start([...f.command, "hold"]);
      expect(await ready(first)).toBe("locked");
      const competing = f.start(["unshare", "--net", ...f.command]);
      expect(await competing.exited).toBe(1);
      expect(await new Response(competing.stderr).text()).toContain("already in progress");
      first.kill("SIGKILL");
      await first.exited;
      const recovered = f.start(["unshare", "--net", ...f.command]);
      expect(await ready(recovered)).toBe("ready");
      expect(await (await fetch("http://localhost/", { unix: f.path })).text()).toBe("ready");
    } finally {
      await f.close();
    }
  },
  15000,
);

test.skipIf(process.platform !== "linux")(
  "Node recovers a dead socket but preserves live listeners and fails closed without flock",
  async () => {
    const f = await fixture();
    try {
      const first = f.start();
      expect(await ready(first)).toBe("ready");
      const inode = (await stat(f.path)).ino;
      const competing = f.start();
      expect(await competing.exited).toBe(1);
      expect(await new Response(competing.stderr).text()).toContain("active listener");
      expect((await stat(f.path)).ino).toBe(inode);
      first.kill("SIGKILL");
      await first.exited;
      const missing = f.start(f.command, { ...process.env, PATH: "/nonexistent" });
      expect(await missing.exited).toBe(1);
      expect(await new Response(missing.stderr).text()).toContain(
        "requires working util-linux flock",
      );
      expect((await stat(f.path)).ino).toBe(inode);
      const recovered = f.start();
      expect(await ready(recovered)).toBe("ready");
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect(await (await fetch("http://localhost/", { unix: f.path })).text()).toBe("ready");
    } finally {
      await f.close();
    }
  },
  15000,
);
