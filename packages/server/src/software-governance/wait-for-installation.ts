import { setTimeout as delay } from "node:timers/promises";
import type { SoftwareOperationView } from "./operation-service";

export class SoftwareInstallationWaitError extends Error {
  constructor(
    readonly reason: "stopped" | "missing" | "failed" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "SoftwareInstallationWaitError";
  }
}

/** A cancelled waiter must not cancel an installation shared by other jobs. */
export async function waitForSoftwareInstallation(input: {
  operationId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  readJobStatus(): Promise<string>;
  readOperation(): Promise<Pick<SoftwareOperationView, "status" | "error"> | null>;
  inventoryReady(): Promise<boolean>;
  sleep?: () => Promise<void>;
}): Promise<void> {
  const deadline = input.timeoutMs > 0 ? Date.now() + input.timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    if ((await input.readJobStatus()) !== "pending") {
      throw new SoftwareInstallationWaitError(
        "stopped",
        "Job stopped while waiting for software installation",
      );
    }
    const operation = await input.readOperation();
    if (!operation)
      throw new SoftwareInstallationWaitError(
        "missing",
        `Software operation ${input.operationId} disappeared`,
      );
    if (operation.status === "failed" || operation.status === "rejected") {
      throw new SoftwareInstallationWaitError(
        "failed",
        `Software operation ${input.operationId} ${operation.status}: ${operation.error ?? "installation failed"}`,
      );
    }
    if (operation.status === "succeeded" && (await input.inventoryReady())) {
      input.signal?.throwIfAborted();
      return;
    }
    try {
      await (input.sleep?.() ?? delay(1000, undefined, { signal: input.signal }));
    } catch (error) {
      input.signal?.throwIfAborted();
      throw error;
    }
  }
  input.signal?.throwIfAborted();
  throw new SoftwareInstallationWaitError(
    "timeout",
    `Timed out waiting for software operation ${input.operationId} and inventory`,
  );
}
