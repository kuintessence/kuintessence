import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test.each([
  { mode: "disabled", flag: "false", user: "kq" },
  { mode: "disabled", flag: "1", user: "kq" },
  { mode: "root-impersonation", flag: "true", user: "root" },
  { mode: "root-impersonation", flag: "TRUE", user: "root" },
  { mode: "disabled", flag: "true", user: "root" },
  { mode: "root-impersonation", flag: "false", user: null },
  { mode: "self-account", flag: "true", user: null },
])("PBS startup selects the declared Agent identity: $mode / $flag", async ({
  mode,
  flag,
  user,
}) => {
  const root = await mkdtemp(join(tmpdir(), "kq-pbs-identity-"));
  directories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const trace = join(root, "trace");
  let source = await readFile(
    resolve(import.meta.dir, "../deploy/schedulers/pbs/entrypoint.sh"),
    "utf8",
  );
  for (const path of [
    "/etc/hosts",
    "/etc/pbs.conf",
    "/var/lib/kuintessence",
    "/var/cache/bun",
    "/scratch",
  ]) {
    source = source.replaceAll(path, join(root, path.replaceAll("/", "_")));
  }
  for (const [path, body] of [
    ["/usr/local/bin/kq-verify-architecture", "exit 0"],
    ["/usr/local/bin/kq-register-compose-agent", 'echo "register:$TEST_RUN_AS" >> "$TEST_TRACE"'],
    ["/usr/local/bin/kq-start-agent", 'echo "start:$TEST_RUN_AS" >> "$TEST_TRACE"; exit 17'],
    ["/etc/init.d/pbs", 'echo "pbs:$1" >> "$TEST_TRACE"'],
  ]) {
    if (!path || !body) throw new Error("Invalid shell fixture");
    const local = join(bin, path.replaceAll("/", "_"));
    await writeFile(local, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    source = source.replaceAll(path, local);
  }
  for (const [name, body] of [
    ["chown", 'echo "owner:$2" >> "$TEST_TRACE"'],
    ["runuser", 'test "$1" = -u; export TEST_RUN_AS="$2"; shift 4; exec "$@"'],
    ["qmgr", "exit 0"],
    ["qstat", "exit 0"],
    ["hostname", "echo scheduler"],
  ]) {
    if (!name || !body) throw new Error("Invalid command fixture");
    await writeFile(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  }
  await writeFile(join(root, "_etc_hosts"), "127.0.0.1 scheduler\n");
  await writeFile(join(root, "_etc_pbs.conf"), "");
  const entry = join(root, "entry.sh");
  await writeFile(entry, source);
  const child = Bun.spawn(["bash", entry], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_TRACE: trace,
      TEST_RUN_AS: "root",
      AGENT_SANDBOX_EXECUTION_MODE: mode,
      AGENT_SANDBOX_ROOT_IMPERSONATION: flag,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(user ? 17 : 2);
  const events = await readFile(trace, "utf8").catch(() => "");
  if (user) {
    expect(events).toContain(`owner:${user}:${user}`);
    expect(events).toContain(`register:${user}`);
    expect(events).toContain(`start:${user}`);
    expect(events).toContain("pbs:stop");
  } else {
    expect(stderr).toContain("PBS root impersonation");
    expect(events).toBe("");
  }
});
