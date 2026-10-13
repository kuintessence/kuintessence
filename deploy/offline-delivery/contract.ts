import {
  OfflineDeliverySchema,
  SpackMaterialImportSchema,
  SpackMaterialManifestSchema,
  SpackMaterialPublishSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { SignedEcosystemBundleEnvelopeSchema } from "../../packages/registry/src/services/ecosystem-release-service";

const argument = process.argv[2];
if (argument === "--schema") {
  process.stdout.write(JSON.stringify({
    version: 1,
    delivery: z.toJSONSchema(OfflineDeliverySchema),
    materialPack: z.toJSONSchema(SpackMaterialImportSchema),
    materialPublish: z.toJSONSchema(SpackMaterialPublishSchema),
    materialManifest: z.toJSONSchema(SpackMaterialManifestSchema),
    signedEcosystemBundle: z.toJSONSchema(SignedEcosystemBundleEnvelopeSchema),
  }, null, 2));
} else if (argument) {
  const result = OfflineDeliverySchema.safeParse(await Bun.file(argument).json());
  process.stdout.write(JSON.stringify(result.success
    ? { valid: true, validation: "contract-only" }
    : { valid: false, issues: result.error.issues }, null, 2));
  process.exitCode = result.success ? 0 : 1;
} else {
  throw new Error("Usage: bun deploy/offline-delivery/contract.ts --schema | delivery.json");
}
