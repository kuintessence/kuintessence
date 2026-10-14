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
      trustedForGlobalUse: true,
      operation: publicOperation,
    }).map(
      (tuple): AuthzProjectionTuple =>
        tuple.relation === "installer" && !input.trustedForGlobalUse
          ? { ...tuple, operation: "delete" }
          : tuple,
    ),
  ];
}

export function softwareAssetOwnerTuple(input: {
  assetId: string;
  userId: string;
}): AuthzProjectionTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function softwareAssetOwnerOrgTuple(input: {
  assetId: string;
  orgId: string;
}): AuthzProjectionTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "owner_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function softwareAssetProviderTuple(input: {
  assetId: string;
  providerOrgId: string;
}): AuthzProjectionTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function softwareAssetGrantTuples(input: {
  assetId: string;
  subjectKind: string;
  subjectId: string;
  capabilities: string[];
  operation: AuthzProjectionTuple["operation"];
}): AuthzProjectionTuple[] {
  const tuples: AuthzProjectionTuple[] = [];
  for (const capability of input.capabilities) {
    const relation = softwareCapabilityToRelation(capability);
    if (!relation) continue;
    const subject = softwareGrantSubject(input.subjectKind, input.subjectId, capability);
    if (!subject) continue;
    tuples.push({
      operation: input.operation,
      resource: { type: "software_asset", id: input.assetId },
      relation,
      subject,
    });
  }
  return tuples;
}

function softwareCapabilityToRelation(capability: string): "viewer" | "user" | "installer" | null {
  if (capability === "view") return "viewer";
  if (capability === "use") return "user";
  if (capability === "install") return "installer";
  return null;
}

function softwareGrantSubject(
  subjectKind: string,
  subjectId: string,
  capability: string,
): AuthzProjectionTuple["subject"] | null {
  if (subjectKind === "user") return { type: "user", id: subjectId };
  if (subjectKind === "org") {
    return {
      type: "organization",
      id: subjectId,
      relation: capability === "view" ? "view" : "use",
    };
  }
  if (subjectKind === "platform") {
    return {
      type: "platform",
      id: "root",
      relation: capability === "view" ? "software_view" : "software_use",
    };
  }
  if (subjectKind === "provider-org" && capability === "install") {
    return { type: "provider", id: subjectId, relation: "operate" };
  }
  return null;
}
