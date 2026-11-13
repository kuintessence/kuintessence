import { z } from "zod";
import {
  EvidenceAdapterConfigSchema,
  EvidenceProposalInputSchema,
  FabricEvidenceAdapter,
} from "./evidence";
import {
  createFabricHttpServer,
  FabricConnectionConfigSchema,
  readAdapterConfigFile,
  startFabricRuntime,
} from "./private-runtime";

export const EvidenceRuntimeConfigSchema = z.strictObject({
  adapter: EvidenceAdapterConfigSchema,
  ...FabricConnectionConfigSchema.shape,
});
export function createEvidenceHttpServer(
  adapter: Pick<FabricEvidenceAdapter, "prepare" | "advance">,
) {
  return createFabricHttpServer("evidence", EvidenceProposalInputSchema, adapter);
}
export async function startEvidenceAdapter(configFile: string) {
  const config = EvidenceRuntimeConfigSchema.parse(await readAdapterConfigFile(configFile));
  const org = config.adapter.trust.organizations.find(
    (org) => org.siteId === config.adapter.siteId,
  );
  if (!org) throw new Error("Unknown local institution");
  return startFabricRuntime(
    config,
    org.mspId,
    (...args) => createEvidenceHttpServer(new FabricEvidenceAdapter(config.adapter, ...args)),
    "evidence.sock",
  );
}
