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

/** Remove only credentials identified as renewable by the original dispatch. */
export function dispatchIntent(
  dispatch: DispatchJob,
  renewableInputs: readonly number[],
): DispatchJob {
  const copy = clone(DispatchJobSchema, dispatch);
  copy.dataDeliveries = copy.dataDeliveries.map(dataIntent);
  for (const index of renewableInputs) {
    const staged = copy.inputStaging[index];
    if (staged) {
      staged.sourceUrl = "";
      staged.deliveryLeaseId = "";
      staged.deliveryLeaseExpiresAtUnixMs = 0n;
    }
  }
  return copy;
}

export function renewableDispatchInputs(dispatch: DispatchJob): number[] {
  return dispatch.inputStaging.flatMap((input, index) =>
    input.deliveryLeaseId || input.deliveryLeaseExpiresAtUnixMs !== 0n ? [index] : [],
  );
}

/** Only the originally declared data credentials may change; commands and signatures stay fixed. */
export function sameDispatchIntent(original: DispatchJob, renewed: DispatchJob): boolean {
  const inputs = renewableDispatchInputs(original);
  return equals(
    DispatchJobSchema,
    dispatchIntent(original, inputs),
    dispatchIntent(renewed, inputs),
  );
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
