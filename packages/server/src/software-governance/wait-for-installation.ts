import type { SoftwareOperationView } from "./operation-service";

/** A cancelled waiter must not cancel an installation shared by other jobs. */
export async function waitForSoftwareInstallation(input: {
  operationId: string;
  timeoutMs: number;
  readJobStatus(): Promise<string>;
  readOperation(): Promise<Pick<SoftwareOperationView, "status" | "error"> | null>;
  inventoryReady(): Promise<boolean>;
  sleep?: () => Promise<void>;
}): Promise<void> {
  const deadline = input.timeoutMs > 0 ? Date.now() + input.timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    if ((await input.readJobStatus()) !== "pending") {
      throw new Error("Job stopped while waiting for software installation");
    }
    const operation = await input.readOperation();
    if (!operation) throw new Error(`Software operation ${input.operationId} disappeared`);
    if (operation.status === "failed" || operation.status === "rejected") {
      throw new Error(
        `Software operation ${input.operationId} ${operation.status}: ${operation.error ?? "installation failed"}`,
      );
    }
    if (operation.status === "succeeded" && (await input.inventoryReady())) return;
    await (input.sleep?.() ?? new Promise((resolve) => setTimeout(resolve, 1000)));
  }
  throw new Error(`Timed out waiting for software operation ${input.operationId} and inventory`);
}
