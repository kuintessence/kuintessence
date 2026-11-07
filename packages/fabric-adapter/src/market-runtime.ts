import { MarketProposalInputSchema } from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { FabricMarketAdapter, MarketAdapterConfigSchema } from "./market";
import {
  createFabricHttpServer,
  FabricConnectionConfigSchema,
  readAdapterConfigFile,
  startFabricRuntime,
} from "./private-runtime";

export const MarketRuntimeConfigSchema = z.strictObject({
  adapter: MarketAdapterConfigSchema,
  ...FabricConnectionConfigSchema.shape,
});
export function createMarketHttpServer(adapter: Pick<FabricMarketAdapter, "prepare" | "advance">) {
  return createFabricHttpServer("market", MarketProposalInputSchema, adapter);
}
export async function startMarketAdapter(configFile: string) {
  const config = MarketRuntimeConfigSchema.parse(await readAdapterConfigFile(configFile));
  const org = config.adapter.trust.organizations.find(
    (org) => org.siteId === config.adapter.siteId,
  );
  if (!org) throw new Error("Unknown local institution");
  return startFabricRuntime(
    config,
    org.mspId,
    (...args) => createMarketHttpServer(new FabricMarketAdapter(config.adapter, ...args)),
    "market.sock",
  );
}
