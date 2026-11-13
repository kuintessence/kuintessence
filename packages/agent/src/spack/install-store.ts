import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  type ExecutionIdentity,
  ExecutionIdentitySchema,
  executionIdentity,
  executionState,
  installWorkerExecution,
  LOCK_HELD,
  RECOVERY_REQUIRED,
  softwareExecution,
} from "./execution-identity";
import {
  isSpackInstallRoot,
  type SpackInstallRecord,
  SpackInstallRecordSchema,
  type SpackWorkerStopProof,
  SpackWorkerStopProofSchema,
} from "./install-contract";
import { removeSpackSupervisedInputs, SpackProcessSupervisionSchema } from "./supervised-process";

type CreateInput = Pick<
  SpackInstallRecord,
  "manifestDigest" | "manifestSize" | "siteProfileDigest" | "spec" | "rootHash"
>;
const LockOwnerSchema = z.strictObject({
  version: z.literal(1),
  identity: ExecutionIdentitySchema,
  operationId: z.string().uuid().optional(),
});
const WorkerSchema = z.strictObject({
  execution: z.string().uuid(),
  recordId: z.string().uuid(),
  stagingPath: z
    .string()
    .regex(/^\/[A-Za-z0-9_./-]+$/)
    .optional(),
});
export interface SpackWorkerRecovery {
  recordId: string;
  operationId: string;
  confirmStopped: (
    stagingPath: string,
    record: SpackInstallRecord,
  ) => Promise<SpackWorkerStopProof | undefined>;
}
const MAX_BYTES = 2 * 1024 ** 2;
const MAX_RECORDS = 1024;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ID = SpackInstallRecordSchema.shape.id;
const CreateSchema = SpackInstallRecordSchema.pick({
  manifestDigest: true,
  manifestSize: true,
  siteProfileDigest: true,
  spec: true,
  rootHash: true,
});
const NEXT: Record<SpackInstallRecord["state"], SpackInstallRecord["state"][]> = {
  building: ["waiting_install", "verifying", "failed"],
  waiting_install: ["building", "failed", "removing"],
  verifying: ["waiting_verify", "ready", "failed"],
  waiting_verify: ["verifying", "failed", "removing"],
  ready: ["unavailable", "removing"],
  unavailable: ["ready", "removing"],
  failed: ["removing"],
  removing: ["removed"],
  removed: [],
};
const IDENTITY = [
  "version",
  "id",
  "manifestDigest",
  "manifestSize",
  "siteProfileDigest",
  "spec",
  "rootHash",
] as const;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function optionalStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function assertDirectory(stat: Stats, owned = false, privateDirectory = false): void {
  const stickyAncestor = !owned && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.uid !== process.getuid?.() && (owned || stat.uid !== 0)) ||
    ((stat.mode & 0o022) !== 0 && !stickyAncestor) ||
    (privateDirectory && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Unsafe Spack store directory ownership, permissions or symlink");
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, DIR_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
// Validate every ancestor before descending; never chmod an existing site directory.
async function directory(path: string, create = false, mode = 0o755): Promise<void> {
  let current = "/";
  assertDirectory(await lstat(current));
  for (const part of path.slice(1).split("/")) {
    current = join(current, part);
    let stat = await optionalStat(current);
    if (!stat && create) {
      let created = false;
      try {
        await mkdir(current, { mode: current === path ? mode : 0o755 });
        created = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      stat = await lstat(current);
      if (created) {
        const handle = await open(current, DIR_FLAGS);
        try {
          assertDirectory(await handle.stat(), true);
          await handle.chmod(current === path ? mode : 0o755);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(dirname(current));
      }
    }
    if (!stat) throw new Error("Missing Spack store directory");
    assertDirectory(stat, current === path, current === path && mode === 0o700);
  }
}
function assertRecordFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > MAX_BYTES ||
    stat.nlink !== 1
  ) {
    throw new Error("Unsafe Spack record file ownership, permissions, type or size");
  }
}

export class SpackInstallStore {
  private readonly context = new AsyncLocalStorage<symbol>();
  private active?: {
    token: symbol;
    stat: Stats;
    path: string;
    workerPending: boolean;
    identity: ExecutionIdentity;
    operationId?: string;
    stoppedWorker?: SpackWorkerStopProof;
  };
  private busy = false;
  private writing = false;
  private readonly records: string;
  private readonly releases: string;
  private readonly lock: string;

  constructor(private readonly root: string) {
    if (!isSpackInstallRoot(root)) throw new Error("Invalid Spack installation store root");
    this.records = join(root, "records");
    this.releases = join(root, "releases");
    this.lock = join(root, ".writer-lock");
  }
  private async layout(create = false): Promise<void> {
    await directory(this.root, create);
    await directory(this.releases, create);
    await directory(this.records, create, 0o700);
  }
  async initialize(): Promise<void> {
    await this.layout(true);
  }
  private async lockJson(path: string): Promise<unknown> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      assertRecordFile(await handle.stat());
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  private async lockWrite(path: string, value: unknown): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  }
  async withLock<T>(
    fn: () => Promise<T>,
    operationId?: string,
    recovery?: SpackWorkerRecovery,
  ): Promise<T> {
    if (this.busy) throw new Error(LOCK_HELD);
    this.busy = true;
    let owned: Stats | undefined;
    let path: string | undefined;
    let recovering = false;
    let stoppedRecord: { recordId: string; proof: SpackWorkerStopProof } | undefined;
    let reconciled = false;
    try {
      await this.layout();
      const execution = softwareExecution.getStore();
      const identity = execution?.identity ?? (await executionIdentity());
      const owner = LockOwnerSchema.parse({
        version: 1,
        identity,
        operationId: execution?.operationId ?? operationId,
      });
      await execution?.bindStore(this.root);
      // Keep the legacy name occupied for the whole protocol lifetime, including idle time.
      try {
        await mkdir(this.lock, { mode: 0o700 });
        await this.lockWrite(join(this.lock, "format.json"), { version: 2 });
        await syncDirectory(this.root);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      try {
        await directory(this.lock, false, 0o700);
        z.strictObject({ version: z.literal(2) }).parse(
          await this.lockJson(join(this.lock, "format.json")),
        );
      } catch {
        throw new Error(RECOVERY_REQUIRED);
      }
      const history = join(this.lock, "generations");
      await directory(history, true, 0o700);
      let count = 0;
      let highest = -1;
      for await (const entry of await opendir(history)) {
        if (!/^\d{16}$/.test(entry.name) || !Number.isSafeInteger(Number(entry.name)))
          throw new Error(RECOVERY_REQUIRED);
        count++;
        highest = Math.max(highest, Number(entry.name));
      }
      if (highest !== count - 1 || !Number.isSafeInteger(count)) throw new Error(RECOVERY_REQUIRED);
      const previous = count ? String(count - 1).padStart(16, "0") : undefined;
      if (previous) {
        const previousPath = join(history, previous);
        try {
          assertDirectory(await lstat(previousPath), true, true);
          const owner = LockOwnerSchema.parse(
            await this.lockJson(join(previousPath, "owner.json")),
          );
          const worker = await optionalStat(join(previousPath, "worker.json"));
          if (worker) {
            const binding = WorkerSchema.parse(
              await this.lockJson(join(previousPath, "worker.json")),
            );
            if (binding.execution !== owner.identity.token) throw new Error(RECOVERY_REQUIRED);
          }
          const uncertain = await optionalStat(join(previousPath, "uncertain.json"));
          if (
            uncertain &&
            (!worker ||
              (await this.lockJson(join(previousPath, "uncertain.json"))) !== owner.identity.token)
          )
            throw new Error(RECOVERY_REQUIRED);
          const released = await optionalStat(join(previousPath, "released.json"));
          if (released && uncertain) throw new Error(RECOVERY_REQUIRED);
          if (released) {
            if ((await this.lockJson(join(previousPath, "released.json"))) !== owner.identity.token)
              throw new Error(RECOVERY_REQUIRED);
          } else {
            recovering = true;
            const state = await executionState(owner.identity, identity);
            let finished:
              | { worker: z.infer<typeof WorkerSchema>; proof: SpackWorkerStopProof }
              | undefined;
            if (await optionalStat(join(previousPath, "worker-finished.json"))) {
              finished = z
                .strictObject({ worker: WorkerSchema, proof: SpackWorkerStopProofSchema })
                .parse(await this.lockJson(join(previousPath, "worker-finished.json")));
              const binding = WorkerSchema.parse(
                await this.lockJson(join(previousPath, "worker.json")),
              );
              const record = (await this.list()).find((entry) => entry.id === binding.recordId);
              if (JSON.stringify(finished.worker) !== JSON.stringify(binding)) {
                // A new worker binding was committed before its predecessor's receipt was removed.
                finished = undefined;
              } else {
                if (
                  !record ||
                  ((record.state === "building" || record.state === "verifying") &&
                    record.operationId !== owner.operationId) ||
                  finished.proof.manifestDigest !== record.manifestDigest ||
                  finished.proof.siteProfileDigest !== record.siteProfileDigest ||
                  finished.proof.storePath !== this.path(record.id)
                )
                  throw new Error(RECOVERY_REQUIRED);
                stoppedRecord = { recordId: record.id, proof: finished.proof };
              }
            }
            // A login host reboot cannot prove a compute-node Slurm worker stopped.
            if (
              worker &&
              WorkerSchema.parse(await this.lockJson(join(previousPath, "worker.json")))
                .stagingPath &&
              !recovery &&
              !finished
            )
              throw new Error(RECOVERY_REQUIRED);
            let recoveredWorker = finished !== undefined;
            if (recovery && !finished) {
              const binding = WorkerSchema.parse(
                await this.lockJson(join(previousPath, "worker.json")),
              );
              const record = (await this.list()).find((entry) => entry.id === recovery.recordId);
              if (
                (state !== "stopped" && state !== "rebooted") ||
                owner.operationId !== recovery.operationId ||
                binding.recordId !== recovery.recordId ||
                !binding.stagingPath ||
                !record ||
                !["building", "verifying"].includes(record.state)
              )
                throw new Error(RECOVERY_REQUIRED);
              const proof = await recovery.confirmStopped(binding.stagingPath, record);
              if (proof) {
                const parsed = SpackWorkerStopProofSchema.parse(proof);
                if (
                  parsed.manifestDigest !== record.manifestDigest ||
                  parsed.siteProfileDigest !== record.siteProfileDigest ||
                  parsed.storePath !== this.path(record.id)
                )
                  throw new Error(RECOVERY_REQUIRED);
                stoppedRecord = { recordId: record.id, proof: parsed };
              }
              recoveredWorker = true;
            }
            const settledOwner = uncertain && owner.identity.instance === identity.instance;
            if (state === "alive" && !settledOwner) throw new Error(LOCK_HELD);
            if (state === "unknown") throw new Error(RECOVERY_REQUIRED);
            if (state !== "rebooted" && worker && !recoveredWorker) {
              if (await optionalStat(join(previousPath, "unsupervised.json")))
                throw new Error(RECOVERY_REQUIRED);
              const supervisors = join(previousPath, "supervisors");
              await directory(supervisors, false, 0o700);
              let count = 0;
              for await (const entry of await opendir(supervisors)) {
                const ref = SpackProcessSupervisionSchema.parse(
                  await this.lockJson(join(supervisors, entry.name)),
                );
                if (entry.name !== `${ref.unit}.json`) throw new Error(RECOVERY_REQUIRED);
                await removeSpackSupervisedInputs(ref);
                count++;
              }
              if (!count) throw new Error(RECOVERY_REQUIRED);
            }
          }
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message === LOCK_HELD ? LOCK_HELD : RECOVERY_REQUIRED,
          );
        }
      }
      path = join(history, String(count).padStart(16, "0"));
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, "EEXIST")) throw new Error(LOCK_HELD);
        throw error;
      }
      owned = await lstat(path);
      assertDirectory(owned, true, true);
      await syncDirectory(history);
      await this.lockWrite(join(path, "owner.json"), owner);
      const token = Symbol("writer");
      const active: NonNullable<SpackInstallStore["active"]> = {
        token,
        stat: owned,
        path,
        workerPending: false,
        identity,
        operationId: execution?.operationId ?? operationId,
      };
      this.active = active;
      return await this.context.run(token, async () => {
        // An exclusive successor proves all predecessors stopped; preserve partial files as evidence.
        for (const record of recovering ? await this.list() : []) {
          if (record.state === "building" || record.state === "verifying") {
            await this.save({
              ...record,
              state: "failed",
              ...(stoppedRecord?.recordId === record.id
                ? { workerStopped: stoppedRecord.proof }
                : {}),
              updatedAt: new Date().toISOString(),
            });
          } else if (record.state === "removing") {
            await this.removeFiles(record.id);
            await this.save({ ...record, state: "removed", updatedAt: new Date().toISOString() });
          }
        }
        reconciled = true;
        return installWorkerExecution.run(
          {
            start: async (recordId, supervisor, stagingPath) => {
              await this.assertLocked();
              if (supervisor) {
                const ref = SpackProcessSupervisionSchema.parse(supervisor);
                const supervisors = join(active.path, "supervisors");
                await directory(supervisors, true, 0o700);
                await this.lockWrite(join(supervisors, `${ref.unit}.json`), ref);
              } else if (!(await optionalStat(join(active.path, "unsupervised.json")))) {
                await this.lockWrite(join(active.path, "unsupervised.json"), identity.token);
              }
              // Persist before spawn; even a crash in the spawn/PID-registration gap is fenced.
              if (active.workerPending) throw new Error(RECOVERY_REQUIRED);
              active.stoppedWorker = undefined;
              const workerPath = join(active.path, `worker-${randomUUID()}.tmp`);
              await this.lockWrite(workerPath, {
                execution: identity.token,
                recordId: ID.parse(recordId),
                ...(stagingPath
                  ? { stagingPath: WorkerSchema.shape.stagingPath.parse(stagingPath) }
                  : {}),
              });
              await rename(workerPath, join(active.path, "worker.json"));
              await syncDirectory(active.path);
              await unlink(join(active.path, "worker-finished.json")).catch((error: unknown) => {
                if (!hasCode(error, "ENOENT")) throw error;
              });
              await syncDirectory(active.path);
              active.workerPending = true;
            },
            finish: async (proof) => {
              if (proof) {
                await this.assertLocked();
                const worker = WorkerSchema.parse(
                  await this.lockJson(join(active.path, "worker.json")),
                );
                const record = await this.read(worker.recordId);
                const parsed = SpackWorkerStopProofSchema.parse(proof);
                if (
                  parsed.manifestDigest !== record.manifestDigest ||
                  parsed.siteProfileDigest !== record.siteProfileDigest ||
                  parsed.storePath !== this.path(record.id)
                )
                  throw new Error(RECOVERY_REQUIRED);
                const temporary = join(active.path, `worker-finished-${randomUUID()}.tmp`);
                await this.lockWrite(temporary, { worker, proof: parsed });
                await rename(temporary, join(active.path, "worker-finished.json"));
                await syncDirectory(active.path);
                active.stoppedWorker = parsed;
              }
              active.workerPending = false;
            },
          },
          fn,
        );
      });
    } finally {
      const active = this.active;
      this.active = undefined;
      try {
        if (active && reconciled && owned && path) {
          const current = await optionalStat(path);
          if (current && sameFile(owned, current)) {
            await this.lockWrite(
              join(path, active.workerPending ? "uncertain.json" : "released.json"),
              active.identity.token,
            );
          }
        }
      } finally {
        this.busy = false;
      }
    }
  }
  async reconcileWorker(recovery: SpackWorkerRecovery): Promise<void> {
    await this.withLock(
      async () => {
        const record = (await this.list()).find((entry) => entry.id === recovery.recordId);
        if (!record || record.state !== "failed") throw new Error(RECOVERY_REQUIRED);
      },
      undefined,
      recovery,
    );
  }
  stoppedWorker(): SpackWorkerStopProof | undefined {
    return this.active?.stoppedWorker;
  }
  workerUncertain(): boolean {
    return this.active?.workerPending === true;
  }
  private async assertLocked(): Promise<void> {
    if (!this.active || this.context.getStore() !== this.active.token) {
      throw new Error("Spack mutation requires the owning withLock context");
    }
    await this.layout();
    await directory(this.lock, false, 0o700);
    const current = await lstat(this.active.path);
    assertDirectory(current, true, true);
    if (!sameFile(this.active.stat, current)) throw new Error("Spack writer lock changed");
  }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writing) throw new Error("Concurrent Spack mutations are not supported");
    this.writing = true;
    try {
      await this.assertLocked();
      return await fn();
    } finally {
      this.writing = false;
    }
  }
  path(id: string): string {
    return join(this.releases, ID.parse(id));
  }
  private recordPath(id: string): string {
    return join(this.records, `${ID.parse(id)}.json`);
  }
  private validate(value: unknown): SpackInstallRecord {
    const record = SpackInstallRecordSchema.parse(value);
    if (record.state === "waiting_install" || record.state === "waiting_verify") {
      if (
        !record.operationId ||
        !record.executionIdentity ||
        (record.state === "waiting_install" && record.buildReport) ||
        (record.state === "waiting_verify" && !record.buildReport)
      )
        throw new Error("Invalid Spack authorization checkpoint");
    }
    if (
      record.buildReport &&
      (record.buildReport.action !== "install" ||
        record.buildReport.root.hash !== record.rootHash ||
        record.buildReport.root.spec !== record.spec ||
        record.buildReport.manifestDigest !== record.manifestDigest ||
        record.buildReport.siteProfileDigest !== record.siteProfileDigest ||
        record.buildReport.storePath !== this.path(record.id))
    )
      throw new Error("Invalid Spack build checkpoint");
    if (record.state === "ready") {
      const report = record.report;
      if (
        !report ||
        report.action !== "verify" ||
        report.root.hash !== record.rootHash ||
        report.root.spec !== record.spec ||
        report.manifestDigest !== record.manifestDigest ||
        report.siteProfileDigest !== record.siteProfileDigest ||
        report.storePath !== this.path(record.id)
      ) {
        throw new Error("Ready Spack record requires a matching verify report");
      }
    }
    return record;
  }
  private async read(id: string): Promise<SpackInstallRecord> {
    const path = this.recordPath(id);
    const entry = await lstat(path);
    assertRecordFile(entry);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      assertRecordFile(stat);
      if (!sameFile(entry, stat)) throw new Error("Spack record changed while opening");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error("Spack record size changed");
      const final = await handle.stat();
      assertRecordFile(final);
      if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || final.mode !== stat.mode) {
        throw new Error("Spack record changed while reading");
      }
      const record = this.validate(JSON.parse(bytes.subarray(0, length).toString("utf8")));
      if (record.id !== id) throw new Error("Spack record filename identity mismatch");
      return record;
    } finally {
      await handle.close();
    }
  }
  async list(): Promise<SpackInstallRecord[]> {
    await this.layout();
    const ids: string[] = [];
    for await (const entry of await opendir(this.records)) {
      if (
        entry.name.startsWith(".") &&
        entry.name.endsWith(".tmp") &&
        ID.safeParse(entry.name.slice(1, -4)).success
      ) {
        assertRecordFile(await lstat(join(this.records, entry.name)));
        continue;
      }
      if (!entry.name.endsWith(".json")) throw new Error("Unexpected Spack record entry");
      ids.push(ID.parse(entry.name.slice(0, -5)));
      if (ids.length > MAX_RECORDS) throw new Error("Spack record limit exceeded");
    }
    const records: SpackInstallRecord[] = [];
    for (const id of ids.sort()) records.push(await this.read(id));
    return records;
  }
  private async write(record: SpackInstallRecord): Promise<void> {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Spack record size limit exceeded");
    const temporary = join(this.records, `.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await this.assertLocked();
      await rename(temporary, this.recordPath(record.id));
      await syncDirectory(this.records);
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }
  async create(input: CreateInput): Promise<SpackInstallRecord> {
    return this.mutate(async () => {
      const record = this.validate({
        ...CreateSchema.parse(input),
        version: 1,
        operationId: this.active?.operationId,
        executionIdentity: this.active?.identity,
        id: randomUUID(),
        state: "building",
        updatedAt: new Date().toISOString(),
      });
      if ((await this.list()).length >= MAX_RECORDS) throw new Error("Spack record limit exceeded");
      await mkdir(this.path(record.id), { mode: 0o700 });
      await syncDirectory(this.releases);
      await this.write(record);
      return record;
    });
  }
  async awaitingAuthorization(operationId: string): Promise<boolean> {
    return (await this.list()).some(
      (record) =>
        record.operationId === operationId &&
        (record.state === "waiting_install" || record.state === "waiting_verify"),
    );
  }

  async cancelAuthorizationWait(operationId: string): Promise<void> {
    await this.withLock(async () => {
      for (const record of await this.list()) {
        if (
          record.operationId === operationId &&
          (record.state === "waiting_install" || record.state === "waiting_verify")
        ) {
          await this.save({ ...record, state: "failed", updatedAt: new Date().toISOString() });
        }
      }
    });
  }

  async resumeFailed(id: string, expected: CreateInput): Promise<SpackInstallRecord> {
    return this.mutate(async () => {
      const previous = await this.read(id);
      const binding = CreateSchema.parse(expected);
      if (
        previous.state !== "failed" ||
        !previous.workerStopped ||
        !previous.operationId ||
        previous.workerStopped.manifestDigest !== previous.manifestDigest ||
        previous.workerStopped.siteProfileDigest !== previous.siteProfileDigest ||
        previous.workerStopped.storePath !== this.path(id) ||
        !this.active?.operationId ||
        this.active.operationId === previous.operationId ||
        Object.entries(binding).some(([key, value]) => previous[key as keyof CreateInput] !== value)
      ) {
        throw new Error("Spack interrupted installation recovery binding mismatch");
      }
      await directory(this.path(id));
      const attempts = join(this.root, "attempts");
      await directory(attempts, true, 0o700);
      const history = join(attempts, id);
      await directory(history, true, 0o700);
      const snapshot = join(history, `${previous.operationId}.json`);
      const bytes = JSON.stringify(previous);
      if (await optionalStat(snapshot)) {
        if (JSON.stringify(await this.lockJson(snapshot)) !== bytes)
          throw new Error(RECOVERY_REQUIRED);
      } else {
        const temporary = join(history, `.${randomUUID()}.tmp`);
        await this.lockWrite(temporary, previous);
        await rename(temporary, snapshot);
        await syncDirectory(history);
      }
      const record = this.validate({
        ...previous,
        state: "building",
        operationId: this.active.operationId,
        executionIdentity: this.active.identity,
        workerStopped: undefined,
        report: undefined,
        resumedFrom: {
          operationId: previous.operationId,
          snapshotSha256: createHash("sha256").update(bytes).digest("hex"),
          schedulerJobId: previous.workerStopped.schedulerJobId,
        },
        updatedAt: new Date().toISOString(),
      });
      await this.write(record);
      return record;
    });
  }
  async save(value: SpackInstallRecord): Promise<void> {
    return this.mutate(async () => {
      const record = this.validate(value);
      const previous = await this.read(record.id);
      if (
        IDENTITY.some((key) => previous[key] !== record[key]) ||
        previous.operationId !== record.operationId ||
        JSON.stringify(previous.executionIdentity) !== JSON.stringify(record.executionIdentity)
      ) {
        throw new Error("Spack record identity is immutable");
      }
      if (
        previous.buildReport &&
        JSON.stringify(previous.buildReport) !== JSON.stringify(record.buildReport)
      )
        throw new Error("Spack build checkpoint is immutable");
      if (record.state !== previous.state && !NEXT[previous.state].includes(record.state)) {
        throw new Error("Invalid Spack installation state transition");
      }
      await this.write(record);
    });
  }
  async removeFiles(id: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(id);
      if (record.state !== "removing" && record.state !== "failed") {
        throw new Error("Spack files can only be removed in removing or failed state");
      }
      const path = this.path(id);
      const stat = await optionalStat(path);
      if (!stat) return;
      assertDirectory(stat, true);
      await rm(path, { recursive: true, force: false });
      await syncDirectory(this.releases);
    });
  }
  async publishFiles(id: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(id);
      if (record.state !== "verifying")
        throw new Error("Spack publication requires verifying state");
      const path = this.path(id);
      const stat = await lstat(path);
      assertDirectory(stat, true);
      const handle = await open(path, DIR_FLAGS);
      try {
        if (!sameFile(stat, await handle.stat()))
          throw new Error("Spack release directory changed");
        await handle.chmod(0o755);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.releases);
    });
  }
}
