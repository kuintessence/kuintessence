import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const supervisor = join(root, "deploy/schedulers/common/supervise-agent.py");
const worker = `#!/usr/bin/python3
import json, os, signal, sys, time
from pathlib import Path
role = 'watchdog' if '--federation-watchdog' in sys.argv else 'agent'
folder = Path(os.environ['KQ_SUPERVISOR_TEST_DIR'])
(folder / (role + '.json')).write_text(json.dumps({'pid': os.getpid(), 'db': os.environ['AGENT_DB_PATH'], 'kubeconfig': os.environ['KUBECONFIG']}))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
 (folder / (role + '.heartbeat')).write_text(str(time.monotonic()))
 time.sleep(0.05)
`;
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Supervisor fixture timed out");
    await Bun.sleep(25);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Agent and watchdog restart separately; termination reaps both and keeps shared private state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-agent-supervisor-"));
  const database = join(directory, "agent.sqlite");
  await writeFile(database, "original state");
  await chmod(database, 0o644);
  await writeFile(join(directory, "bun"), worker, { mode: 0o700 });
  const child = Bun.spawn(["python3", supervisor], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AGENT_DB_PATH: database,
      KUBECONFIG: join(directory, "private-config"),
      KQ_SUPERVISOR_TEST_DIR: directory,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const pids = new Set<number>();
  const identity = async (
    name: string,
  ): Promise<{ pid: number; db: string; kubeconfig: string } | undefined> => {
    try {
      return JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
    } catch {
      return undefined;
    }
  };
  try {
    await until(async () => !!(await identity("agent")) && !!(await identity("watchdog")));
    for (const name of ["agent", "watchdog"]) {
      const value = await identity(name);
      expect(value?.db).toBe(database);
      expect(value?.kubeconfig).toBe(join(directory, "private-config"));
    }
    expect((await stat(database)).mode & 0o777).toBe(0o600);
    expect(await readFile(database, "utf8")).toBe("original state");
    for (const victim of ["agent", "watchdog"]) {
      const other = victim === "agent" ? "watchdog" : "agent";
      const before = await identity(victim);
      const survivor = await identity(other);
      if (!before || !survivor) throw new Error("Missing fixture process");
      pids.add(before.pid);
      pids.add(survivor.pid);
      const heartbeat = await readFile(join(directory, `${other}.heartbeat`), "utf8");
      process.kill(before.pid, "SIGKILL");
      await until(async () => {
        const next = await identity(victim);
        if (!next || next.pid === before.pid) return false;
        pids.add(next.pid);
        return true;
      });
      expect((await identity(other))?.pid).toBe(survivor.pid);
      expect(alive(survivor.pid)).toBe(true);
      expect(await readFile(join(directory, `${other}.heartbeat`), "utf8")).not.toBe(heartbeat);
    }
    child.kill("SIGTERM");
    expect(await child.exited, await errors).toBe(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("supervisor refuses linked state without altering the target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-agent-supervisor-link-"));
  try {
    const target = join(directory, "target");
    const database = join(directory, "agent.sqlite");
    await writeFile(target, "untouched", { mode: 0o644 });
    await symlink(target, database);
    const child = Bun.spawn(["python3", supervisor], {
      env: { ...process.env, AGENT_DB_PATH: database },
      stdout: "ignore",
      stderr: "pipe",
    });
    const errors = new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(await errors).toContain("must not contain symlinks");
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("container startup loads registered environment before supervising both children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-agent-startup-"));
  const database = join(directory, "registered.sqlite");
  const start = join(directory, "start.sh");
  for (const folder of [
    "packages/agent",
    "node_modules/pino",
    "node_modules/ssh2",
    "node_modules/@kuintessence/db",
  ])
    await mkdir(join(directory, folder), { recursive: true });
  await writeFile(join(directory, "package.json"), "{}");
  await writeFile(join(directory, "bun"), worker, { mode: 0o700 });
  await writeFile(
    join(directory, "agent.env"),
    `AGENT_ID=registered-agent\nAGENT_SITE_NAME=registered-site\nSERVER_GRPC_URL=http://127.0.0.1:1\nAGENT_DB_PATH=${database}\n`,
  );
  const source = await readFile(join(root, "deploy/schedulers/common/start-agent.sh"), "utf8");
  await writeFile(
    start,
    source
      .replaceAll("/workspace", directory)
      .replace("/usr/local/bin/kq-supervise-agent.py", supervisor),
  );
  const child = Bun.spawn(["bash", start], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      KQ_AGENT_ENV_FILE: join(directory, "agent.env"),
      KQ_SUPERVISOR_TEST_DIR: directory,
      KUBECONFIG: "fixture",
      BUN_INSTALL_CACHE_DIR: join(directory, "cache"),
      AGENT_DB_PATH: join(directory, "wrong.sqlite"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  try {
    await until(
      async () =>
        (await Bun.file(join(directory, "watchdog.json")).exists()) &&
        (await Bun.file(join(directory, "agent.json")).exists()),
    );
    for (const name of ["agent", "watchdog"])
      expect((await Bun.file(join(directory, `${name}.json`)).json()).db).toBe(database);
    expect((await stat(database)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(directory, "wrong.sqlite")).exists()).toBe(false);
  } finally {
    child.kill("SIGTERM");
    expect(await child.exited, await errors).toBe(0);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
