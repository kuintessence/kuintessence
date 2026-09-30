import assert from "node:assert/strict";
import { SpackMaterialBindingSchema } from "@kuintessence/shared";
import { z } from "zod";
import { OperationSchema } from "../spack-case/api";

export const WebInstallReceiptSchema = z.strictObject({
  version: z.literal(1),
  agentId: z.literal("pr-scheduler"),
  action: z.literal("install"),
  spec: z.literal("hello@2.12.1"),
  status: z.literal("succeeded"),
  operationId: z.string().uuid(),
  binding: SpackMaterialBindingSchema,
});
export type WebInstallReceipt = z.infer<typeof WebInstallReceiptSchema>;

const ObservedOperationSchema = OperationSchema.extend({
  agentId: z.string(),
  action: z.string(),
  spec: z.string(),
  stdout: z.string().nullable(),
});

export function verifyWebInstallHistory(receipt: WebInstallReceipt, value: unknown) {
  const expected = WebInstallReceiptSchema.parse(receipt);
  const history = z.object({ items: z.array(ObservedOperationSchema) }).parse(value);
  const installs = history.items.filter(
    (item) => item.action === expected.action && item.spec === expected.spec,
  );
  assert.equal(installs.length, 1, "Expected exactly one browser installation");
  const operation = installs[0];
  assert(
    operation &&
      operation.id === expected.operationId &&
      operation.agentId === expected.agentId &&
      operation.status === expected.status,
    "Browser receipt does not match persisted operation",
  );
  return operation;
}

export async function readWebInstallReceipt() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    assert(Buffer.isBuffer(chunk));
    size += chunk.byteLength;
    assert(size <= 16_384, "Browser receipt exceeds the byte limit");
    chunks.push(chunk);
  }
  return WebInstallReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
