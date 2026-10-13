import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OFFLINE_DELIVERY_MAX_BYTES, type OfflineDeliveryReport } from "@kuintessence/shared";
import { openMaterialImportFile, readMaterialImportManifest } from "./material-import-files";
import type { OfflineDeliveryService } from "./offline-delivery";

async function importSeed(
  service: OfflineDeliveryService,
  path: string,
  subject: string,
): Promise<OfflineDeliveryReport> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("DELIVERY_SEED_PATH_INVALID");
  const root = dirname(path);
  const signal = AbortSignal.timeout(24 * 60 * 60_000);
  const plan = service.parse(
    await readMaterialImportManifest(root, basename(path), OFFLINE_DELIVERY_MAX_BYTES, signal),
  );
  service.authorize(plan, await service.principal(subject));
  // Validate every local byte before writing any Registry upload receipt.
  for (const file of plan.files) {
    const stream = await openMaterialImportFile(
      root,
      file.path,
      file.blob.size,
      service.options.materials.limits.maxBlobBytes,
      signal,
    );
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== file.blob.digest)
      throw new Error("DELIVERY_SEED_DIGEST_MISMATCH");
  }
  for (const file of plan.files) {
    const stream = await openMaterialImportFile(
      root,
      file.path,
      file.blob.size,
      service.options.materials.limits.maxBlobBytes,
      signal,
    );
    await service.options.materials.upload(plan.repository, file.blob.digest, stream);
  }
  for (;;) {
    signal.throwIfAborted();
    try {
      return await service.run(plan, subject);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "DELIVERY_BUSY") throw error;
      await delay(1000, undefined, { signal });
    }
  }
}

export async function seedOfflineDelivery(
  service: OfflineDeliveryService,
  path: string,
  subject: string,
): Promise<OfflineDeliveryReport> {
  const target = `delivery-seed:${subject}`;
  await service.options.receipts.append(target, subject, { status: "running" });
  try {
    const report = await importSeed(service, path, subject);
    await service.options.receipts.append(target, subject, report);
    return report;
  } catch (error) {
    const code =
      error instanceof Error && /^DELIVERY_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DELIVERY_SEED_INPUT_FAILED";
    await service.options.receipts.append(target, subject, { status: "failed", code });
    throw error;
  }
}
