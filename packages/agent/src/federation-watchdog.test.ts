import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "@kuintessence/db";

for (const initialize of [false, true]) {
  test(`independent watchdog waits for fresh schema and ${initialize ? "continues without restart" : "stops while waiting"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-watchdog-start-"));
    const path = join(root, "agent.db");
    const database = new Database(path, { create: true });
    await chmod(path, 0o600);
    const worker = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import {runFederationWatchdog} from ${JSON.stringify(join(import.meta.dir, "federation-watchdog.ts"))}; await runFederationWatchdog();`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          AGENT_DB_PATH: path,
          AGENT_SCHEDULER_TYPE: "slurm",
          AGENT_SCHEDULER_VERSION: "24.11.5",
          LOG_LEVEL: "info",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => worker.kill("SIGKILL"), 5_000);
    const reader = worker.stdout.getReader();
    const errors = new Response(worker.stderr).text();
    let output = "";
    const until = async (message: string) => {
      while (!output.includes(message)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        if (chunk.done) throw new Error(`Watchdog exited early: ${await errors}`);
        output += new TextDecoder().decode(chunk.value);
      }
    };
    try {
      await until("Waiting for Agent database initialization");
      expect(worker.exitCode).toBeNull();
      expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
        [],
      );
      if (initialize) {
        const agent = createSqliteDb(path);
        agent.$client.close();
        await until("Federation watchdog database ready");
        expect(worker.exitCode).toBeNull();
      }
      worker.kill("SIGTERM");
      expect(await worker.exited).toBe(0);
      expect(await errors).toBe("");
      if (!initialize)
        expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
          [],
        );
    } finally {
      clearTimeout(deadline);
      worker.kill("SIGKILL");
      await worker.exited;
      reader.releaseLock();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
}
