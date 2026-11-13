import { FabricEvidenceTrustSchema } from "@kuintessence/shared/federation/ledger";
import { z } from "zod";

export const Site = z.object({
  name: z.enum(["A", "B", "C"]),
  siteId: z.uuid(),
  peerPort: z.number().int(),
  tls: z.string(),
  adminMsp: z.string(),
  userMsp: z.string(),
  businessKeyFile: z.string(),
});
export const Network = z.object({
  channel: z.literal("kq-evidence-test"),
  chaincode: z.literal("kq-evidence"),
  trust: FabricEvidenceTrustSchema,
  sites: z.array(Site).length(3),
});
