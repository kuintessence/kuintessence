import { posix } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DataDeliveryBindingSchema,
  DataDeliveryMethod,
  type InputStaging,
} from "@kuintessence/proto";
import { z } from "zod";

/** Use the same bounded download, digest verification and cleanup as Data Market files. */
export function netdriveDeliveries(inputs: readonly InputStaging[]) {
  return inputs.map((input, index) => {
    if (
      !input.netdriveInput ||
      !z.uuid().safeParse(input.fileMetadataId).success ||
      !input.stagePath ||
      posix.isAbsolute(input.stagePath) ||
      input.stagePath.includes("\\") ||
      input.stagePath.includes("\0") ||
      input.stagePath.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
      input.expectedSizeBytes < 0n ||
      input.expectedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("NetDrive input is missing its immutable file binding");
    return create(DataDeliveryBindingSchema, {
      bindingId: `netdrive-${index}-${input.fileMetadataId}`,
      assetId: input.fileMetadataId,
      versionId: input.expectedSha256,
      manifestDigest: input.expectedSha256,
      stagePath: posix.dirname(input.stagePath),
      method: DataDeliveryMethod.OBJECT_DOWNLOAD,
      leaseId: input.deliveryLeaseId,
      leaseExpiresAtUnixMs: input.deliveryLeaseExpiresAtUnixMs,
      selectedEntries: [
        {
          path: posix.basename(input.stagePath),
          sha256: input.expectedSha256,
          sizeBytes: input.expectedSizeBytes,
          objectDownloadUrl: input.sourceUrl,
        },
      ],
    });
  });
}
