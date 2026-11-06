import { clone, equals } from "@bufbuild/protobuf";
import {
  type DataDeliveryBinding,
  DataDeliveryBindingSchema,
  type DispatchJob,
  DispatchJobSchema,
  type SoftwareOperationRequest,
  SoftwareOperationRequestSchema,
} from "./generated/kuintessence/v1/agent_service_pb.js";

function dataIntent(binding: DataDeliveryBinding): DataDeliveryBinding {
  return {
    ...binding,
    leaseId: "",
    leaseExpiresAtUnixMs: 0n,
    selectedEntries: binding.selectedEntries.map((entry) => ({ ...entry, objectDownloadUrl: "" })),
  };
}

export function sameDataDeliveryIntent(
  original: DataDeliveryBinding,
  renewed: DataDeliveryBinding,
): boolean {
  return equals(DataDeliveryBindingSchema, dataIntent(original), dataIntent(renewed));
}

/** Only the originally declared data credentials may change; commands and signatures stay fixed. */
export function sameDispatchIntent(original: DispatchJob, renewed: DispatchJob): boolean {
  const redact = (dispatch: DispatchJob) => {
    const copy = clone(DispatchJobSchema, dispatch);
    copy.dataDeliveries = copy.dataDeliveries.map(dataIntent);
    for (const [index, input] of original.inputStaging.entries()) {
      if (!input.deliveryLeaseId && input.deliveryLeaseExpiresAtUnixMs === 0n) continue;
      const staged = copy.inputStaging[index];
      if (staged) {
        staged.sourceUrl = "";
        staged.deliveryLeaseId = "";
        staged.deliveryLeaseExpiresAtUnixMs = 0n;
      }
    }
    return copy;
  };
  return equals(DispatchJobSchema, redact(original), redact(renewed));
}

export function sameInstallationIntent(
  original: SoftwareOperationRequest,
  renewed: SoftwareOperationRequest,
): boolean {
  return equals(
    SoftwareOperationRequestSchema,
    { ...original, spackMaterialTicket: "" },
    { ...renewed, spackMaterialTicket: "" },
  );
}
