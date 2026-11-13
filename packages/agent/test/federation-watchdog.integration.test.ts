import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import { DispatchJobSchema } from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ActiveRemoteJobs } from "../src/queue/active-remote-jobs";
import {
  federationDispatchReceipt,
  federationSchedulerName,
} from "../src/queue/federation-dispatch";
import { InboundAcks } from "../src/queue/inbound-acks";

const schedulerCli = `#!/usr/bin/python3
import json, os, signal, sys
from pathlib import Path
path = Path(os.environ['KQ_TEST_SCHEDULER_STATE'])
state = json.loads(path.read_text())
command = Path(sys.argv[0]).name
if command == 'sbatch':
    if state['type'] != 'slurm': sys.exit(1)
    print('slurm 24.11.0')
elif command == 'qsub':
    print('pbs_version = 23.0.0')
elif command == 'qsig':
    if sys.argv[1:] != ['-s', 'KILL', state['schedulerJobId']]: sys.exit(2)
    try: os.kill(state['pid'], signal.SIGKILL)
    except ProcessLookupError: pass
    state['killSent'] = True
    path.write_text(json.dumps(state))
elif command in ('scancel', 'qdel'):
    if sys.argv[1] != state['schedulerJobId']: sys.exit(2)
    try: os.kill(state['pid'], signal.SIGTERM)
    except ProcessLookupError: pass
    state['stopped'] = True
    path.write_text(json.dumps(state))
elif command == 'squeue' and '--json' not in sys.argv:
    print(state['schedulerJobId'] + '|' + state['schedulerName'] + '|KQ_JOB_ID=' + state['jobId'] + '|default')
elif command == 'squeue':
    print(json.dumps({'jobs': [{'job_id': state['schedulerJobId'], 'job_state': 'CANCELLED' if state['stopped'] else 'RUNNING'}]}))
elif command == 'qstat':
    print(json.dumps({'Jobs': {state['schedulerJobId']: {'Job_Name': state['schedulerName'], 'Variable_List': {'KQ_JOB_ID': state['jobId']}, 'job_state': 'F' if state['stopped'] else 'R', 'Exit_status': 143 if state['stopped'] else 0}}}))
else:
    sys.exit(2)
`;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Watchdog condition timed out");
    await Bun.sleep(30);
  }
}

test.each([
  "slurm",
  "pbs-pro",
] as const)("container supervisor keeps the independent watchdog stopping real work after AgentStream SIGKILL (%s CLI double)", async (schedulerType) => {
  const directory = await mkdtemp(join(tmpdir(), "kq-watchdog-"));
  const path = join(directory, "agent.sqlite");
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  runSqliteMigrations(sqlite);
  await chmod(path, 0o600);
  const db = drizzle(sqlite, { schema });
  const inbox = new InboundAcks(db);
  const dispatch = create(DispatchJobSchema, {
    jobId: crypto.randomUUID(),
    dispatchEpoch: 12n,
    federationExecution: true,
  });
  const dispatchId = `${dispatch.jobId}:12`;
  const spec = {
    jobId: dispatch.jobId,
    name: "lightweight",
    schedulerName: federationSchedulerName(12n),
    command: "sleep 60",
    cpus: 1,
    memoryMb: 32,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: directory,
    envVars: {},
  };
  await inbox.persistInbound({
    dispatchId,
    jobId: dispatch.jobId,
    payload: { federationExecution: true, federationReceipt: federationDispatchReceipt(dispatch) },
  });
  await inbox.markSubmissionStarted(
    dispatchId,
    { spec, expectedOutputs: [] },
    { owner: "agent-process", expiresAt: Date.now() + 5000, state: "active" },
  );
  await inbox.markAcked(dispatchId);
  const schedulerJobId = schedulerType === "slurm" ? "123" : "123.server";
  await new ActiveRemoteJobs(db).recordSubmitted({
    dispatchId,
    spec,
    schedulerJobId,
    expectedOutputs: [],
  });
  const worker = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const statePath = join(directory, "scheduler.json");
  await writeFile(
    statePath,
    JSON.stringify({
      type: schedulerType,
      schedulerJobId,
      schedulerName: spec.schedulerName,
      jobId: spec.jobId,
      pid: worker.pid,
      stopped: false,
    }),
  );
  const cli = join(directory, "scheduler-cli");
  await writeFile(cli, schedulerCli, { mode: 0o700 });
  for (const command of ["sbatch", "squeue", "scancel", "qsub", "qstat", "qdel", "qsig"])
    await symlink(cli, join(directory, command));
  const binary = process.env.KQ_TEST_WATCHDOG_BINARY;
  const watchdogCommand = binary
    ? [resolve(binary), "--federation-watchdog"]
    : [
        process.execPath,
        new URL("../src/index.ts", import.meta.url).pathname,
        "--federation-watchdog",
      ];
  const writerCommand = [
    process.execPath,
    new URL("./fixtures/federation-runtime-renewer.ts", import.meta.url).pathname,
    path,
    statePath,
  ];
  const shim = `#!/usr/bin/python3
import json, os, sys
from pathlib import Path
folder = Path(os.environ['KQ_TEST_SUPERVISOR_DIR'])
if '--federation-watchdog' in sys.argv:
    (folder / 'watchdog.pid').write_text(str(os.getpid()))
    command = json.loads(os.environ['KQ_TEST_WATCHDOG_COMMAND'])
else:
    marker = folder / 'agent.pid'
    if marker.exists():
        # Simulate an Agent that cannot restart while the independent watchdog must still act.
        (folder / 'restart-attempted').touch()
        sys.exit(19)
    marker.write_text(str(os.getpid()))
    command = json.loads(os.environ['KQ_TEST_AGENT_COMMAND'])
os.execv(command[0], command)
`;
  await writeFile(join(directory, "bun"), shim, { mode: 0o700 });
  const supervisor = Bun.spawn(
    [
      "python3",
      new URL("../../../deploy/schedulers/common/supervise-agent.py", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        AGENT_DB_PATH: path,
        AGENT_SPAWNER_BACKEND: "host",
        LOG_LEVEL: "error",
        KQ_TEST_SCHEDULER_STATE: statePath,
        KQ_TEST_SUPERVISOR_DIR: directory,
        KQ_TEST_WATCHDOG_COMMAND: JSON.stringify(watchdogCommand),
        KQ_TEST_AGENT_COMMAND: JSON.stringify(writerCommand),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const supervisorError = new Response(supervisor.stderr).text();
  try {
    await waitFor(async () => {
      if (supervisor.exitCode !== null) throw new Error(await supervisorError);
      try {
        await inbox.assertWatchdogReady(schedulerType);
        return true;
      } catch {
        return false;
      }
    });
    await waitFor(async () => {
      if (supervisor.exitCode !== null) throw new Error(await supervisorError);
      const counter = Bun.file(`${statePath}.renewals`);
      return (await counter.exists()) && Number(await counter.text()) >= 2;
    });
    await Bun.sleep(1100);
    const writerPid = Number(await Bun.file(join(directory, "agent.pid")).text());
    const watchdogPid = Number(await Bun.file(join(directory, "watchdog.pid")).text());
    expect(process.kill(writerPid, 0)).toBe(true);
    expect(worker.exitCode).toBeNull();
    process.kill(writerPid, "SIGKILL");
    await waitFor(async () => !!(await inbox.get(dispatchId))?.payload.federationRuntimeStop);
    expect(await worker.exited).not.toBe(0);
    const stopped: { killSent?: boolean } = await Bun.file(statePath).json();
    expect(stopped.killSent).toBe(schedulerType === "pbs-pro" ? true : undefined);
    expect((await inbox.get(dispatchId))?.payload.federationRuntime).toMatchObject({
      state: "stopping",
    });
    expect(await new ActiveRemoteJobs(db).listActive()).toHaveLength(1);
    await waitFor(async () => Bun.file(join(directory, "restart-attempted")).exists());
    expect(Number(await Bun.file(join(directory, "watchdog.pid")).text())).toBe(watchdogPid);
    expect(process.kill(watchdogPid, 0)).toBe(true);
  } finally {
    worker.kill("SIGKILL");
    supervisor.kill("SIGTERM");
    await Promise.all([worker.exited, supervisor.exited, supervisorError]);
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
