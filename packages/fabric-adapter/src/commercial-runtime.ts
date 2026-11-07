import {
  CommercialAdapterProposalInputSchema,
  CommercialGateQuerySchema,
  CommercialReceiptQuerySchema,
} from "@kuintessence/shared/federation/commercial";
import { z } from "zod";
import { CommercialAdapterConfigSchema, FabricCommercialAdapter } from "./commercial";
import {
  createFabricHttpServer,
  FabricConnectionConfigSchema,
  readAdapterConfigFile,
  startFabricRuntime,
} from "./private-runtime";

export const CommercialRuntimeConfigSchema = z.strictObject({
  adapter: CommercialAdapterConfigSchema,
  ...FabricConnectionConfigSchema.shape,
});
export function createCommercialHttpServer(
  adapter: Pick<FabricCommercialAdapter, "prepare" | "advance" | "query" | "receipt">,
) {
  return createFabricHttpServer(
    "commercial",
    CommercialAdapterProposalInputSchema,
    adapter,
    (raw) => {
      const input = z.union([CommercialGateQuerySchema, CommercialReceiptQuerySchema]).parse(raw);
      return input.operation === "get-commercial-receipt"
        ? adapter.receipt(input)
        : adapter.query(input);
    },
  );
}
export async function startCommercialAdapter(configFile: string) {
  const config = CommercialRuntimeConfigSchema.parse(await readAdapterConfigFile(configFile));
  const org = config.adapter.trust.organizations.find(
    (org) => org.siteId === config.adapter.siteId,
  );
  if (!org) throw new Error("Unknown local institution");
  return startFabricRuntime(
    config,
    org.mspId,
    (...args) => createCommercialHttpServer(new FabricCommercialAdapter(config.adapter, ...args)),
    "commercial.sock",
  );
}
