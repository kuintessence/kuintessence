import { z } from "zod";
import { FederationInputCopyTaskSchema } from "./input-transfer";
import { FEDERATION_MEDIA_MAX_FILES } from "./media";
import { FederationMediaImportTaskSchema } from "./media-import-task";
import { FederationResultCopyBindingSchema } from "./result-transfer";

/** Private quarantined member to an original task transfer; neither generation may be substituted. */
export const FederationMediaUploadTaskSchema = z.strictObject({
  media: FederationMediaImportTaskSchema,
  memberIndex: z
    .number()
    .int()
    .min(0)
    .max(FEDERATION_MEDIA_MAX_FILES - 1),
  target: z.discriminatedUnion("kind", [
    FederationInputCopyTaskSchema.extend({ kind: z.literal("task-input") }),
    z.strictObject({
      kind: z.literal("task-result"),
      binding: FederationResultCopyBindingSchema,
      availableUntil: z.iso.datetime(),
    }),
  ]),
});
export type FederationMediaUploadTask = z.infer<typeof FederationMediaUploadTaskSchema>;
