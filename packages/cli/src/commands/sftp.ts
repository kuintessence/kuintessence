import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";

const transport = `#!/bin/sh
if [ -n "$KQ_SFTP_ENTRY" ]; then
  exec "$KQ_SFTP_EXEC" "$KQ_SFTP_ENTRY" ssh --sftp-stdio -- "$KQ_SFTP_AGENT"
fi
exec "$KQ_SFTP_EXEC" ssh --sftp-stdio -- "$KQ_SFTP_AGENT"
`;

export function copyAgent(source: string, destination: string): string {
  const remote = [source, destination].filter((path) => /^[^/:]+:/.test(path));
  const match =
    remote.length === 1 ? /^([A-Za-z0-9][A-Za-z0-9_.-]*):(.+)$/s.exec(remote[0] ?? "") : null;
  if (!match?.[1]) throw new Error("Specify one local path and one agentId:remote-path");
  return match[1];
}

async function runOpenSsh(program: "scp" | "sftp", agent: string, args: string[]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(agent)) throw new Error("Invalid agent ID");
  const dir = await mkdtemp(join(tmpdir(), "kq-sftp-"));
  try {
    const helper = join(dir, "transport");
    await writeFile(helper, transport, { mode: 0o700, flag: "wx" });
    const entry = import.meta.path.includes("$bunfs")
      ? ""
      : resolve(import.meta.dir, "../index.ts");
    // scp expects a single executable path. sftp tokenizes its -D argument.
    const driver = program === "scp" ? helper : '"' + helper.replace(/["\\]/g, "\\$&") + '"';
    const child = Bun.spawn([program, "-D", driver, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        KQ_SFTP_EXEC: process.execPath,
        KQ_SFTP_ENTRY: entry,
        KQ_SFTP_AGENT: agent,
      },
    });
    process.exitCode = await child.exited;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

export function registerSftpCommands(program: Command) {
  program
    .command("sftp <agentId>")
    .description("Transfer files through the SSH gateway using OpenSSH sftp")
    .option("-b, --batch <file>", "Read SFTP commands from a batch file")
    .action((agent: string, opts: { batch?: string }) =>
      runOpenSsh("sftp", agent, opts.batch ? ["-b", opts.batch] : []),
    );
  program
    .command("scp <source> <destination>")
    .description("Copy between a local path and agentId:remote-path using OpenSSH 9+")
    .option("-r, --recursive", "Copy directories recursively")
    .action((source: string, destination: string, opts: { recursive?: boolean }) =>
      runOpenSsh("scp", copyAgent(source, destination), [
        ...(opts.recursive ? ["-r"] : []),
        "--",
        source,
        destination,
      ]),
    );
}
