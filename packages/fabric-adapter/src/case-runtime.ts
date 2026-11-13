import {
  CaseProposalSchema,
  CaseReceiptQuerySchema,
} from "@kuintessence/shared/federation/case-ledger";
import { z } from "zod";
import { CaseAdapterConfigSchema, FabricCaseAdapter } from "./case";
import {
  createFabricHttpServer,
  FabricConnectionConfigSchema,
  readAdapterConfigFile,
  startFabricRuntime,
} from "./private-runtime";

export const CaseRuntimeConfigSchema = z.strictObject({
  adapter: CaseAdapterConfigSchema,
  ...FabricConnectionConfigSchema.shape,
});
export function createCaseHttpServer(
  adapter: Pick<FabricCaseAdapter, "prepare" | "advance" | "receipt">,
) {
  return createFabricHttpServer("case", CaseProposalSchema, adapter, (raw) =>
    adapter.receipt(CaseReceiptQuerySchema.parse(raw)),
  );
}
export async function startCaseAdapter(configFile: string) {
  const config = CaseRuntimeConfigSchema.parse(await readAdapterConfigFile(configFile));
  const org = config.adapter.trust.organizations.find(
    (org) => org.siteId === config.adapter.siteId,
  );
  if (!org) throw new Error("Unknown local institution");
  return startFabricRuntime(
    config,
    org.mspId,
    (...args) => createCaseHttpServer(new FabricCaseAdapter(config.adapter, ...args)),
    "case.sock",
  );
}
