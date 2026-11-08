import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { realpath, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  FederationError,
  type FederationMode,
  FederationModeSchema,
} from "@kuintessence/shared/federation";
import { z } from "zod";
import { readStorageFile } from "./storage-files";
import { CompletionReserveObservationSchema, observeCompletionReserve } from "./storage-reserve";

export { readStorageFile } from "./storage-files";

const Path = z.string().startsWith("/").max(4096);
const Bytes = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const Identity = {
  version: z.literal(1),
  volumeId: z.uuid(),
  storageId: z.uuid(),
  observedAt: z.iso.datetime(),
};
export const StorageObservationSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      ...Identity,
      state: z.literal("observed"),
      device: Bytes,
      filesystemType: Bytes,
      totalBytes: Bytes,
      availableBytes: Bytes,
      totalInodes: Bytes.nullable(),
      availableInodes: Bytes.nullable(),
      completionReserve: CompletionReserveObservationSchema.optional(),
    })
    .refine(
      (v) =>
        BigInt(v.totalBytes) > 0n &&
        BigInt(v.availableBytes) <= BigInt(v.totalBytes) &&
        ((v.totalInodes === null && v.availableInodes === null) ||
          (v.totalInodes !== null &&
            v.availableInodes !== null &&
            BigInt(v.totalInodes) > 0n &&
            BigInt(v.availableInodes) <= BigInt(v.totalInodes))),
    ),
  z.strictObject({ ...Identity, state: z.literal("unavailable") }),
]);
export type StorageObservation = z.infer<typeof StorageObservationSchema>;
const SignedObservation = z.strictObject({
  payload: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(12000),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const StorageObserverConfigSchema = z.strictObject({
  version: z.literal(1),
  volumeId: z.uuid(),
  storageId: z.uuid(),
  probeDirectory: Path,
  signingKeyFile: Path,
  reportFile: Path,
  intervalSec: z.number().int().min(1).max(300),
  completionReserve: z.strictObject({ reserveId: z.uuid(), configFile: Path }).optional(),
});
export type StorageObserverConfig = z.infer<typeof StorageObserverConfigSchema>;
export const StorageGuardConfigSchema = z
  .strictObject({
    version: z.literal(1),
    siteId: z.uuid(),
    volumes: z
      .array(
        z.strictObject({
          volumeId: z.uuid(),
          storageId: z.uuid(),
          name: z.string().trim().min(1).max(200),
          component: z.enum([
            "postgres-data",
            "postgres-wal",
            "peer",
            "orderer",
            "archive",
            "agent-staging",
          ]),
          modes: z.array(FederationModeSchema).min(1).max(3),
          reportFile: Path,
          publicKeyPem: z.string().min(1).max(16384),
          maxReportAgeSec: z.number().int().min(2).max(600),
          minAvailableBytes: Bytes,
          minAvailablePercent: z.number().int().min(0).max(100),
          completionHeadroomBytes: Bytes,
          minAvailableInodes: Bytes,
          requiredCompletionReserve: z
            .strictObject({ reserveId: z.uuid(), minAllocatedBytes: Bytes })
            .optional(),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.volumes.map((v) => v.volumeId)).size !== value.volumes.length ||
      new Set(value.volumes.map((v) => v.reportFile)).size !== value.volumes.length
    )
      ctx.addIssue({ code: "custom", message: "Storage volumes and report paths must be unique" });
    for (const mode of FederationModeSchema.options)
      if (!value.volumes.some((v) => v.component === "postgres-data" && v.modes.includes(mode)))
        ctx.addIssue({
          code: "custom",
          message: "Every admission mode requires a database volume policy",
        });
  });
type GuardConfig = z.infer<typeof StorageGuardConfigSchema>;

export async function loadStorageObserverKey(path: string) {
  const key = createPrivateKey(await readStorageFile(path, 16384, true));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Storage observer requires Ed25519");
  return key;
}

/** The marker is provisioned by the storage administrator on the actual backing volume. */
export async function observeStorage(
  config: StorageObserverConfig,
  clock = () => new Date(),
): Promise<StorageObservation> {
  const identity = { version: 1 as const, volumeId: config.volumeId, storageId: config.storageId };
  try {
    const directory = await realpath(config.probeDirectory);
    if ((await readStorageFile(join(directory, ".kq-storage-id"), 128)).trim() !== config.storageId)
      throw new Error("Storage identity mismatch");
    const before = await stat(directory, { bigint: true });
    const capacity = await statfs(directory, { bigint: true });
    const after = await stat(directory, { bigint: true });
    if (
      !before.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (await readStorageFile(join(directory, ".kq-storage-id"), 128)).trim() !== config.storageId
    )
      throw new Error("Storage volume changed during observation");
    return StorageObservationSchema.parse({
      ...identity,
      observedAt: clock().toISOString(),
      state: "observed",
      device: before.dev.toString(),
      filesystemType: capacity.type.toString(),
      totalBytes: (capacity.blocks * capacity.bsize).toString(),
      availableBytes: (capacity.bavail * capacity.bsize).toString(),
      totalInodes: capacity.files > 0n ? capacity.files.toString() : null,
      availableInodes: capacity.files > 0n ? capacity.ffree.toString() : null,
      ...(config.completionReserve
        ? {
            completionReserve: await observeCompletionReserve(config.completionReserve.configFile, {
              volumeId: config.volumeId,
              storageId: config.storageId,
              reserveId: config.completionReserve.reserveId,
              device: before.dev.toString(),
            }),
          }
        : {}),
    });
  } catch {
    return { ...identity, observedAt: clock().toISOString(), state: "unavailable" };
  }
}

export function signStorageObservation(observation: StorageObservation, key: KeyObject) {
  const bytes = Buffer.from(JSON.stringify(StorageObservationSchema.parse(observation)));
  return JSON.stringify({
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, key).toString("base64url"),
  });
}

export class FederationStorageGuard {
  private readonly latestObserved = new Map<string, number>();
  private constructor(
    private readonly config: GuardConfig,
    private readonly keys: Map<string, KeyObject>,
    private readonly clock: () => Date,
  ) {}

  static async load(path: string, siteId: string, clock = () => new Date()) {
    const config = StorageGuardConfigSchema.parse(
      JSON.parse(await readStorageFile(path, 131072, true)),
    );
    if (config.siteId !== siteId) throw new Error("Storage policy belongs to another site");
    const keys = new Map<string, KeyObject>();
    for (const volume of config.volumes) {
      const key = createPublicKey(volume.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Storage observer requires Ed25519");
      keys.set(volume.volumeId, key);
    }
    return new FederationStorageGuard(config, keys, clock);
  }

  async inspect(mode?: FederationMode) {
    return Promise.all(
      this.config.volumes
        .filter((v) => !mode || v.modes.includes(mode))
        .map(async (volume) => {
          const identity = {
            volumeId: volume.volumeId,
            name: volume.name,
            component: volume.component,
            modes: volume.modes,
          };
          try {
            const signed = SignedObservation.parse(
              JSON.parse(await readStorageFile(volume.reportFile)),
            );
            const bytes = Buffer.from(signed.payload, "base64url");
            const key = this.keys.get(volume.volumeId);
            if (!key || !verify(null, bytes, key, Buffer.from(signed.signature, "base64url")))
              throw new Error("Invalid observation signature");
            const report = StorageObservationSchema.parse(JSON.parse(bytes.toString("utf8")));
            if (report.volumeId !== volume.volumeId || report.storageId !== volume.storageId)
              throw new Error("Unexpected storage identity");
            const ageMs = this.clock().getTime() - Date.parse(report.observedAt);
            if (ageMs < -5000 || ageMs >= volume.maxReportAgeSec * 1000)
              return { ...identity, state: "stale" as const, observedAt: report.observedAt };
            const observedAt = Date.parse(report.observedAt);
            if (observedAt < (this.latestObserved.get(volume.volumeId) ?? 0))
              return { ...identity, state: "stale" as const, observedAt: report.observedAt };
            this.latestObserved.set(volume.volumeId, observedAt);
            if (report.state === "unavailable")
              return { ...identity, state: "unavailable" as const, observedAt: report.observedAt };
            const percentage =
              (BigInt(report.totalBytes) * BigInt(volume.minAvailablePercent) + 99n) / 100n;
            const floor =
              BigInt(volume.minAvailableBytes) > percentage
                ? BigInt(volume.minAvailableBytes)
                : percentage;
            const requiredBytes = floor + BigInt(volume.completionHeadroomBytes);
            const lowBytes = BigInt(report.availableBytes) <= requiredBytes;
            const lowInodes =
              BigInt(volume.minAvailableInodes) > 0n &&
              (report.availableInodes === null ||
                BigInt(report.availableInodes) < BigInt(volume.minAvailableInodes));
            const reserve = report.completionReserve;
            const requiredReserve = volume.requiredCompletionReserve;
            const lowReserve = !reserve
              ? !!requiredReserve
              : reserve.state !== "armed" ||
                reserve.allocatedBytes === null ||
                BigInt(reserve.allocatedBytes) <
                  BigInt(requiredReserve?.minAllocatedBytes ?? "1") ||
                (!!requiredReserve && reserve.reserveId !== requiredReserve.reserveId);
            return {
              ...identity,
              state:
                lowBytes || lowInodes || lowReserve ? ("pressure" as const) : ("healthy" as const),
              observedAt: report.observedAt,
              totalBytes: report.totalBytes,
              availableBytes: report.availableBytes,
              availableInodes: report.availableInodes,
              requiredBytes: requiredBytes.toString(),
              minAvailableInodes: volume.minAvailableInodes,
              ...(requiredReserve || reserve
                ? { requiredCompletionReserve: requiredReserve, completionReserve: reserve ?? null }
                : {}),
            };
          } catch {
            return { ...identity, state: "unavailable" as const, observedAt: null };
          }
        }),
    );
  }

  async assertAdmission(mode: FederationMode) {
    if ((await this.inspect(mode)).some((volume) => volume.state !== "healthy"))
      throw new FederationError("STORAGE_PRESSURE");
  }
}
