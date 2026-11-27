import {
  OfflineDeliverySchema,
  SignedEcosystemBundleEnvelopeSchema,
  SignedOfflineDeliverySchema,
  SpackMaterialImportSchema,
  SpackMaterialManifestSchema,
  SpackMaterialPublishSchema,
} from "@kuintessence/shared";
import { z } from "zod";

const argument = process.argv[2];
if (argument === "--schema") {
  process.stdout.write(JSON.stringify({
    version: 1,
    delivery: z.toJSONSchema(OfflineDeliverySchema),
    signedDelivery: z.toJSONSchema(SignedOfflineDeliverySchema),
    materialPack: z.toJSONSchema(SpackMaterialImportSchema),
    materialPublish: z.toJSONSchema(SpackMaterialPublishSchema),
    materialManifest: z.toJSONSchema(SpackMaterialManifestSchema),
    signedEcosystemBundle: z.toJSONSchema(SignedEcosystemBundleEnvelopeSchema),
  }, null, 2));
} else if (argument) {
  const input = await Bun.file(argument).json();
  const envelope = SignedOfflineDeliverySchema.safeParse(input);
  let plan:unknown = input;
  if (envelope.success) {
    try {plan = JSON.parse(envelope.data.payload);} catch {plan = null;}
  }
  const result = OfflineDeliverySchema.safeParse(plan);
  process.stdout.write(JSON.stringify(result.success
    ? { valid: true, validation: "contract-only" }
    : { valid: false, issues: result.error.issues }, null, 2));
  process.exitCode = result.success ? 0 : 1;
} else {
  throw new Error("Usage: bun deploy/offline-delivery/contract.ts --schema | delivery.json");
}
