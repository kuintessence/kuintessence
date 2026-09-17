export type AuthzProjectionOperation = "create" | "delete";

export interface AuthzProjectionTuple {
  operation: AuthzProjectionOperation;
  resource: { type: string; id: string };
  relation: string;
  subject: { type: string; id: string; relation?: string | null };
  payload?: Record<string, unknown>;
}

export function dataAssetPlatformTuple(
  assetId: string,
  operation: AuthzProjectionOperation = "create",
): AuthzProjectionTuple {
  return {
    operation,
    resource: { type: "data_asset", id: assetId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function dataAssetPublicAccessTuples(input: {
  assetId: string;
  operation?: AuthzProjectionOperation;
}): AuthzProjectionTuple[] {
  const operation = input.operation ?? "create";
  return [
    {
      operation,
      resource: { type: "data_asset", id: input.assetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    },
    {
      operation,
      resource: { type: "data_asset", id: input.assetId },
      relation: "user",
      subject: { type: "platform", id: "root", relation: "software_use" },
    },
  ];
}

export function dataAssetPublicTuples(input: {
  assetId: string;
  accessMode: string;
}): AuthzProjectionTuple[] {
  return input.accessMode === "open" ? dataAssetPublicAccessTuples(input) : [];
}

export function softwareAssetPlatformTuple(
  assetId: string,
  operation: AuthzProjectionOperation = "create",
): AuthzProjectionTuple {
  return {
    operation,
    resource: { type: "software_asset", id: assetId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function softwareAssetPublicGrantTuples(input: {
  assetId: string;
  trustedForGlobalUse: boolean;
  operation: AuthzProjectionOperation;
}): AuthzProjectionTuple[] {
  const tuples: AuthzProjectionTuple[] = [
    {
      operation: input.operation,
      resource: { type: "software_asset", id: input.assetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    },
    {
      operation: input.operation,
      resource: { type: "software_asset", id: input.assetId },
      relation: "user",
      subject: { type: "platform", id: "root", relation: "software_use" },
    },
  ];
  if (input.trustedForGlobalUse || input.operation === "delete") {
    tuples.push({
      operation: input.operation,
      resource: { type: "software_asset", id: input.assetId },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
  }
  return tuples;
}

export function softwareAssetAuthzProjectionTuples(input: {
  assetId: string;
  lifecycle: string;
  visibility: string;
  trustedForGlobalUse: boolean;
}): AuthzProjectionTuple[] {
  const publicOperation =
    input.lifecycle === "published" && input.visibility === "platform-public" ? "create" : "delete";
  return [
    softwareAssetPlatformTuple(input.assetId),
    ...softwareAssetPublicGrantTuples({
      assetId: input.assetId,
      trustedForGlobalUse: input.trustedForGlobalUse,
      operation: publicOperation,
    }),
  ];
}
