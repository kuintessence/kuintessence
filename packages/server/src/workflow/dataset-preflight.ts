import {
  AppError,
  type DataInputRef,
  ErrorCode,
  usecase,
  type workflowDsl,
} from "@kuintessence/shared";

export interface DatasetPreflightDeps {
  loadUsecasePackage(usecaseVersionId: string): Promise<unknown | null>;
  assertUsecaseExecutionAccess(input: {
    usecaseVersionId: string;
    requester: { userId: string; orgId: string | null; subject?: string | null };
  }): Promise<void>;
  resolveWorkflowVersion(workflowVersionId: string): Promise<workflowDsl.Workflow | null>;
  verifyAccess(input: {
    actorUserId: string;
    orgId: string | null;
    assetId: string;
    versionId: string;
  }): Promise<boolean>;
  validateUsecase(input: {
    pkg: usecase.GovernedUsecasePackage;
    dataInputs: Record<string, DataInputRef>;
  }): Promise<unknown>;
}

export function createDatasetPreflight(deps: DatasetPreflightDeps) {
  return async (
    workflow: workflowDsl.Workflow,
    principal?: { userId: string | null; orgId: string | null; sub?: string | null },
  ): Promise<void> => {
    await validateSpec(deps, workflow.spec, principal, new Set());
  };
}

async function validateSpec(
  deps: DatasetPreflightDeps,
  spec: workflowDsl.WorkflowSpec,
  principal: { userId: string | null; orgId: string | null; sub?: string | null } | undefined,
  visitedWorkflowVersions: ReadonlySet<string>,
): Promise<void> {
  for (const node of spec.nodeDrafts) {
    if (node.type === "Loop") {
      await validateSpec(deps, node.body, principal, visitedWorkflowVersions);
      continue;
    }
    if (node.type === "SubWorkflow") {
      if (node.ref.kind === "Inline") {
        await validateSpec(deps, node.ref.body, principal, visitedWorkflowVersions);
        continue;
      }
      if (visitedWorkflowVersions.has(node.ref.workflowVersionId)) continue;
      const referenced = await deps.resolveWorkflowVersion(node.ref.workflowVersionId);
      if (!referenced) {
        throw new Error(`workflow version not found: ${node.ref.workflowVersionId}`);
      }
      await validateSpec(
        deps,
        referenced.spec,
        principal,
        new Set([...visitedWorkflowVersions, node.ref.workflowVersionId]),
      );
      continue;
    }
    if (node.type !== "SoftwareUsecaseComputing") continue;
    if (!node.usecaseVersionId) {
      throw new Error(`workflow node ${node.id} has no resolved usecase version`);
    }
    if (!principal?.userId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Canonical workflow principal is required", 403);
    }
    await deps.assertUsecaseExecutionAccess({
      usecaseVersionId: node.usecaseVersionId,
      requester: { userId: principal.userId, orgId: principal.orgId, subject: principal.sub },
    });
    const stored = await deps.loadUsecasePackage(node.usecaseVersionId);
    if (!stored) throw new Error(`usecase package not found: ${node.usecaseVersionId}`);
    const pkg = usecase.UsecasePackageSchema.parse(stored);
    const dataInputs = datasetInputsFromNode(node);
    if (!("softwareRef" in pkg)) {
      throw new Error(
        "Workflow execution requires a governed usecase package with a software selector",
      );
    }
    for (const input of Object.values(dataInputs)) {
      if (input.source !== "data-market") continue;
      if (
        !(await deps.verifyAccess({
          actorUserId: principal.userId,
          orgId: principal.orgId,
          assetId: input.assetId,
          versionId: input.versionId,
        }))
      ) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "Not authorized to use the selected Data Market version",
          403,
        );
      }
    }
    await deps.validateUsecase({ pkg, dataInputs });
  }
}

function datasetInputsFromNode(
  node: Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>,
): Record<string, DataInputRef> {
  return Object.fromEntries(
    (node.inputSlots ?? []).flatMap((slot) =>
      slot.type === "Dataset" && slot.contents ? [[slot.descriptor, slot.contents]] : [],
    ),
  );
}
