import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executionIdentity,
  executionState,
  hostIdentity,
  installWorkerExecution,
  LOCK_HELD,
  RECOVERY_REQUIRED,
} from "./execution-identity";
import { SpackInstallStore } from "./install-store";

let base: string;
let root: string;
const generation = (index: number) =>
  join(root, ".writer-lock", "generations", String(index).padStart(16, "0"));
const input = {
  manifestDigest: `sha256:${"a".repeat(64)}`,
  manifestSize: 1,
  siteProfileDigest: `sha256:${"b".repeat(64)}`,
  spec: "fixture@1",
  rootHash: "a".repeat(32),
};
beforeEach(async () => {
  base = await mkdtemp("/tmp/kq-recovery-");
  root = join(base, "store");
  await new SpackInstallStore(root).initialize();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function abandoned(
  overrides: Partial<Awaited<ReturnType<typeof executionIdentity>>> = {},
  worker = false,
) {
  const store = new SpackInstallStore(root);
  await store.withLock(async () => {
    await store.create(input);
  });
  const identity = { ...(await executionIdentity()), start: "0", ...overrides };
  await writeFile(join(generation(0), "owner.json"), JSON.stringify({ version: 1, identity }), {
    mode: 0o600,
  });
  await rm(join(generation(0), "released.json"));
  if (worker)
    await writeFile(
      join(generation(0), "worker.json"),
      JSON.stringify({ execution: identity.token, recordId: (await store.list())[0]?.id }),
      { mode: 0o600 },
    );
  return store;
}

test("production host identity is stable, process start is checked and tokens are unique", async () => {
  const a = await executionIdentity();
  const b = await executionIdentity();
  expect(a.host).toBe(b.host);
  expect(a.boot).toBe(b.boot);
  expect(a.start).toBe(b.start);
  expect(a.token).not.toBe(b.token);
  expect(await executionState(a, b)).toBe("alive");
  expect(await executionState({ ...a, start: "0" }, b)).toBe("stopped");
  expect(await executionState({ ...a, host: "0".repeat(64) }, b)).toBe("unknown");
});

test("reboot permits recovery including a worker marker; partial files are preserved", async () => {
  const store = await abandoned({ boot: randomUUID() }, true);
  const [before] = await store.list();
  if (!before) throw new Error("missing fixture");
  await writeFile(join(store.path(before.id), "evidence"), "partial");
  await store.withLock(async () => {});
  expect((await store.list())[0]?.state).toBe("failed");
  expect(await readFile(join(store.path(before.id), "evidence"), "utf8")).toBe("partial");
  await expect(mkdir(join(root, ".writer-lock"))).rejects.toMatchObject({ code: "EEXIST" });
});

test("PID reuse before any worker start is recoverable without treating the reused PID as owner", async () => {
  const store = await abandoned();
  await store.withLock(async () => {});
  expect((await store.list())[0]?.state).toBe("failed");
});

test.each([
  "foreign-host",
  "worker",
  "empty-generation",
  "corrupt-owner",
  "legacy-empty",
  "corrupt-format",
  "corrupt-worker-after-reboot",
  "corrupt-uncertain-after-reboot",
])("fails closed for %s", async (kind) => {
  const store = await abandoned(
    kind === "foreign-host"
      ? { host: "0".repeat(64), boot: randomUUID() }
      : kind.endsWith("after-reboot")
        ? { boot: randomUUID() }
        : {},
    kind === "worker",
  );
  if (kind === "corrupt-worker-after-reboot")
    await writeFile(join(generation(0), "worker.json"), "{");
  if (kind === "corrupt-uncertain-after-reboot")
    await writeFile(join(generation(0), "uncertain.json"), "{}");
  if (kind === "empty-generation") await rm(join(generation(0), "owner.json"));
  if (kind === "corrupt-owner") await writeFile(join(generation(0), "owner.json"), "{");
  if (kind === "corrupt-format") await writeFile(join(root, ".writer-lock", "format.json"), "{}");
  if (kind === "legacy-empty") {
    await rename(join(root, ".writer-lock"), join(root, "evidence"));
    await mkdir(join(root, ".writer-lock"));
  }
  await expect(
    store.withLock(async () => {
      throw new Error("must not enter");
    }),
  ).rejects.toThrow(RECOVERY_REQUIRED);
});

test("concurrent recovery elects one writer and never recycles its predecessor", async () => {
  await abandoned({ boot: randomUUID() }, true);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let winners = 0;
  let losers = 0;
  const rejected = Promise.withResolvers<void>();
  const runs = Array.from({ length: 8 }, () =>
    new SpackInstallStore(root)
      .withLock(async () => {
        winners++;
        entered.resolve();
        await release.promise;
      })
      .catch((error: unknown) => {
        expect(String(error)).toMatch(/SPACK_(LOCK_HELD|RECOVERY_REQUIRED)/);
        if (++losers === 7) rejected.resolve();
      }),
  );
  await entered.promise;
  await expect(new SpackInstallStore(root).withLock(async () => {})).rejects.toThrow(LOCK_HELD);
  await rejected.promise;
  release.resolve();
  await Promise.all(runs);
  expect(winners).toBe(1);
});

test("a recovery crash before owner publication remains explicitly unknown", async () => {
  await abandoned({ boot: randomUUID() });
  await mkdir(generation(1), { mode: 0o700 });
  await expect(new SpackInstallStore(root).withLock(async () => {})).rejects.toThrow(
    RECOVERY_REQUIRED,
  );
});

test("a recovery crash after publication retries unfinished record reconciliation", async () => {
  const store = await abandoned({ boot: randomUUID() });
  await mkdir(generation(1), { mode: 0o700 });
  await writeFile(
    join(generation(1), "owner.json"),
    JSON.stringify({ version: 1, identity: { ...(await executionIdentity()), start: "0" } }),
    { mode: 0o600 },
  );
  await store.withLock(async () => {});
  expect((await store.list())[0]?.state).toBe("failed");
});

test("uncertain worker keeps the lock, confirmed completion releases it", async () => {
  const store = new SpackInstallStore(root);
  await store.withLock(async () => {
    await installWorkerExecution.getStore()?.start(randomUUID());
    await installWorkerExecution.getStore()?.finish();
  });
  await store.withLock(async () => {
    await installWorkerExecution.getStore()?.start(randomUUID());
  });
  await expect(new SpackInstallStore(root).withLock(async () => {})).rejects.toThrow(
    RECOVERY_REQUIRED,
  );
});

test("real Agent SIGKILL before spawn recovers; a live orphan worker is never reclaimed", async () => {
  for (const worker of [false, true]) {
    const childRoot = join(base, worker ? "with-worker" : "no-worker");
    const program = `
      import { SpackInstallStore } from ${JSON.stringify(join(import.meta.dir, "install-store.ts"))};
      import { installWorkerExecution } from ${JSON.stringify(join(import.meta.dir, "execution-identity.ts"))};
      const store = new SpackInstallStore(${JSON.stringify(childRoot)});
      await store.initialize();
      await store.withLock(async () => {
        await store.create(${JSON.stringify(input)});
        let pid = 0;
        if (${worker}) {
          await installWorkerExecution.getStore().start(crypto.randomUUID());
          const child = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          pid = child.pid;
        }
        setInterval(() => {}, 1000);
        console.log(JSON.stringify({ pid }));
        await new Promise(() => {});
      });`;
    const child = Bun.spawn([process.execPath, "--eval", program], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let workerPid = 0;
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      if (!first.value) throw new Error(await new Response(child.stderr).text());
      workerPid = (JSON.parse(new TextDecoder().decode(first.value)) as { pid: number }).pid;
      expect(child.exitCode).toBeNull();
      process.kill(child.pid, 0);
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const store = new SpackInstallStore(childRoot);
      if (worker) {
        process.kill(workerPid, 0);
        await expect(store.withLock(async () => {})).rejects.toThrow(RECOVERY_REQUIRED);
      } else {
        await store.withLock(async () => {});
        expect((await store.list())[0]?.state).toBe("failed");
      }
    } finally {
      child.kill("SIGKILL");
      if (workerPid) process.kill(workerPid, "SIGKILL");
      await child.exited;
    }
  }
});

test("lock history has no 10000-operation shutdown threshold", async () => {
  const store = new SpackInstallStore(root);
  await store.withLock(async () => {});
  const owner = await readFile(join(generation(0), "owner.json"));
  const released = await readFile(join(generation(0), "released.json"));
  for (let first = 1; first <= 10000; first += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, 10001 - first) }, (_, offset) =>
        mkdir(generation(first + offset), { mode: 0o700 }),
      ),
    );
  }
  await writeFile(join(generation(10000), "owner.json"), owner, { mode: 0o600 });
  await writeFile(join(generation(10000), "released.json"), released, { mode: 0o600 });
  await store.withLock(async () => {});
  expect(JSON.parse(await readFile(join(generation(10001), "owner.json"), "utf8")).version).toBe(1);
});

test("cloned machine-id with different trusted hostnames is foreign even when boots differ", async () => {
  const current = await executionIdentity();
  const machine = "a".repeat(32);
  const local = { ...current, host: hostIdentity(machine, "node-a.example") };
  const remote = { ...current, host: hostIdentity(machine, "node-b.example"), boot: randomUUID() };
  expect(remote.host).not.toBe(local.host);
  expect(await executionState(remote, local)).toBe("unknown");
  const store = await abandoned(remote, true);
  await expect(store.withLock(async () => {})).rejects.toThrow(RECOVERY_REQUIRED);
});

test("invalid host identity components fail closed", () => {
  for (const [machine, host] of [
    ["0".repeat(32), "node-a"],
    ["a".repeat(32), ""],
    ["a".repeat(32), "node/a"],
    ["a".repeat(32), "untrusted host"],
  ] as const) {
    expect(() => hostIdentity(machine, host)).toThrow(RECOVERY_REQUIRED);
  }
});
