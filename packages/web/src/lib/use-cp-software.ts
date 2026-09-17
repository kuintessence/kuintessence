import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import {
  type AvailabilityPreviewRequest,
  CpApiError,
  type CpSoftwareOverview,
  editSoftwarePolicy,
  getSoftwareOverview,
  listSoftwareOperations,
  listSoftwarePolicies,
  type PolicyOverlayInput,
  type PreinstalledMappingReviewRequest,
  type ProviderPolicyInput,
  previewSoftwareAvailability,
  requestSoftwareOperation,
  requestSoftwareOperationsBatch,
  reviewPreinstalledMapping,
  type SoftwareAvailabilityPreview,
  type SoftwareOperation,
  type SoftwareOperationAction,
  type SoftwareOperationBatchRequest,
  type SoftwareOperationBatchResponse,
  type SoftwareOperationRequest,
  type SoftwareOperationStatus,
  type SoftwarePolicy,
  type SoftwarePolicyEdit,
  saveAgentSoftwarePolicy,
  saveClusterSoftwarePolicy,
  saveProviderSoftwarePolicy,
} from "./cp-client";

const KEY = ["cp", "software", "policies"] as const;
const OVERVIEW_KEY = ["cp", "software", "overview"] as const;
const OPERATIONS_KEY = ["cp", "software", "operations"] as const;
export const SOFTWARE_OPERATION_HISTORY_LIMIT = 200;
export const QUEUED_SOFTWARE_OPERATION_POLL_WINDOW_MS = 5 * 60 * 1_000;
const OPERATION_AGENT_KEY_INDEX = OPERATIONS_KEY.length;
const OPERATION_ACTION_KEY_INDEX = OPERATION_AGENT_KEY_INDEX + 1;
const OPERATION_STATUS_KEY_INDEX = OPERATION_AGENT_KEY_INDEX + 2;

export function useCpSoftwarePolicies() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<SoftwarePolicy[]>({
    queryKey: [...KEY, activeOrganizationId ?? "all"],
    queryFn: () => listSoftwarePolicies(),
  });
}

export function useCpEditSoftwarePolicy() {
  const qc = useQueryClient();
  return useMutation<void, Error, SoftwarePolicyEdit>({
    mutationFn: (p) => editSoftwarePolicy(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
  });
}

export function useCpSoftwareOverview() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<CpSoftwareOverview>({
    queryKey: [...OVERVIEW_KEY, activeOrganizationId ?? "all"],
    queryFn: () => getSoftwareOverview(),
  });
}

export function useCpSaveProviderSoftwarePolicy() {
  const qc = useQueryClient();
  return useMutation<CpSoftwareOverview, Error, ProviderPolicyInput>({
    mutationFn: (p) => saveProviderSoftwarePolicy(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCpSaveAgentSoftwarePolicy() {
  const qc = useQueryClient();
  return useMutation<CpSoftwareOverview, Error, { agentId: string; policy: PolicyOverlayInput }>({
    mutationFn: ({ agentId, policy }) => saveAgentSoftwarePolicy(agentId, policy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCpSaveClusterSoftwarePolicy() {
  const qc = useQueryClient();
  return useMutation<CpSoftwareOverview, Error, { clusterId: string; policy: PolicyOverlayInput }>({
    mutationFn: ({ clusterId, policy }) => saveClusterSoftwarePolicy(clusterId, policy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCpSoftwareAvailabilityPreview() {
  return useMutation<SoftwareAvailabilityPreview, Error, AvailabilityPreviewRequest>({
    mutationFn: (p) => previewSoftwareAvailability(p),
  });
}

export function useCpSoftwareOperations(
  agentId: string | null,
  filters: {
    action?: SoftwareOperationAction | null;
    status?: SoftwareOperationStatus | null;
  } = {},
) {
  const activeOrganizationId = useActiveOrganizationId();
  const action = filters.action ?? null;
  const status = filters.status ?? null;
  return useQuery<SoftwareOperation[]>({
    queryKey: [...OPERATIONS_KEY, agentId, action, status, activeOrganizationId ?? "all"],
    queryFn: () =>
      listSoftwareOperations({
        ...(agentId ? { agentId } : {}),
        ...(action ? { action } : {}),
        ...(status ? { status } : {}),
        limit: SOFTWARE_OPERATION_HISTORY_LIMIT,
      }),
    refetchInterval: (query) => (shouldPollSoftwareOperations(query.state.data) ? 3_000 : false),
    enabled: agentId !== null,
  });
}

export function softwareOperationMatchesQueryKey(
  operation: SoftwareOperation,
  queryKey: readonly unknown[],
): boolean {
  if (!isSoftwareOperationQueryKey(queryKey)) return false;
  if (queryKey[OPERATION_AGENT_KEY_INDEX] !== operation.agentId) return false;
  const action = queryKey[OPERATION_ACTION_KEY_INDEX];
  if (action != null && action !== operation.action) return false;
  const status = queryKey[OPERATION_STATUS_KEY_INDEX];
  if (status != null && status !== operation.status) return false;
  return true;
}

function isSoftwareOperationQueryKey(queryKey: readonly unknown[]): boolean {
  return OPERATIONS_KEY.every((part, index) => queryKey[index] === part);
}

export function shouldPollSoftwareOperations(operations: SoftwareOperation[] | undefined): boolean {
  return shouldPollSoftwareOperationsAt(operations, Date.now());
}

export function shouldPollSoftwareOperationsAt(
  operations: SoftwareOperation[] | undefined,
  nowMs: number,
): boolean {
  return (
    operations?.some((operation) => {
      if (operation.status === "running") return true;
      if (operation.status !== "queued") return false;
      const timestamp = Date.parse(operation.updatedAt || operation.requestedAt);
      if (Number.isNaN(timestamp)) return true;
      return nowMs - timestamp <= QUEUED_SOFTWARE_OPERATION_POLL_WINDOW_MS;
    }) ?? false
  );
}

export function mergeSoftwareOperationHistory(
  current: SoftwareOperation[] | undefined,
  incoming: SoftwareOperation[],
): SoftwareOperation[] {
  const byId = new Map<string, SoftwareOperation>();
  for (const operation of current ?? []) {
    byId.set(operation.id, operation);
  }
  for (const operation of incoming) {
    byId.set(operation.id, newerSoftwareOperation(byId.get(operation.id), operation));
  }
  return [...byId.values()]
    .sort(compareSoftwareOperationsByRecency)
    .slice(0, SOFTWARE_OPERATION_HISTORY_LIMIT);
}

function newerSoftwareOperation(
  current: SoftwareOperation | undefined,
  incoming: SoftwareOperation,
): SoftwareOperation {
  if (!current) return incoming;
  return operationTimestampMs(incoming.updatedAt) >= operationTimestampMs(current.updatedAt)
    ? incoming
    : current;
}

function compareSoftwareOperationsByRecency(a: SoftwareOperation, b: SoftwareOperation): number {
  const requestedDiff = operationTimestampMs(b.requestedAt) - operationTimestampMs(a.requestedAt);
  if (requestedDiff !== 0) return requestedDiff;
  const updatedDiff = operationTimestampMs(b.updatedAt) - operationTimestampMs(a.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;
  return b.id.localeCompare(a.id);
}

function operationTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function useCpRequestSoftwareOperation() {
  const qc = useQueryClient();
  return useMutation<SoftwareOperation, Error, SoftwareOperationRequest>({
    mutationFn: (p) => requestSoftwareOperation(p),
    retry: shouldRetrySoftwareOperation,
    onSuccess: (result, variables) => {
      mergeSoftwareOperationHistoryIntoCachedQueries(qc, variables.agentId, [result]);
      qc.invalidateQueries({ queryKey: [...OPERATIONS_KEY, variables.agentId] });
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCpRequestSoftwareOperationsBatch() {
  const qc = useQueryClient();
  return useMutation<SoftwareOperationBatchResponse, Error, SoftwareOperationBatchRequest>({
    mutationFn: async (p) =>
      normalizeSoftwareOperationBatchResponse(await requestSoftwareOperationsBatch(p)),
    retry: shouldRetrySoftwareOperation,
    onSuccess: (result, variables) => {
      mergeSoftwareOperationHistoryIntoCachedQueries(qc, variables.agentId, result.items);
      qc.invalidateQueries({ queryKey: [...OPERATIONS_KEY, variables.agentId] });
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function shouldRetrySoftwareOperation(failureCount: number, error: Error): boolean {
  if (failureCount >= 1) return false;
  return !(error instanceof CpApiError && error.status >= 400 && error.status < 500);
}

export function useCpReviewPreinstalledMapping() {
  const qc = useQueryClient();
  const activeOrganizationId = useActiveOrganizationId();
  return useMutation<CpSoftwareOverview, Error, PreinstalledMappingReviewRequest>({
    mutationFn: (p) => reviewPreinstalledMapping(p),
    onSuccess: (overview) => {
      qc.setQueryData([...OVERVIEW_KEY, activeOrganizationId ?? "all"], overview);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function normalizeSoftwareOperationBatchResponse(
  response:
    | SoftwareOperationBatchResponse
    | SoftwareOperation[]
    | {
        items: SoftwareOperation[];
        summary?: Partial<SoftwareOperationBatchResponse["summary"]>;
      },
): SoftwareOperationBatchResponse {
  if (!Array.isArray(response)) {
    return {
      items: response.items,
      summary: completeSoftwareOperationBatchSummary(response.items.length, response.summary),
    };
  }
  return {
    items: response,
    summary: completeSoftwareOperationBatchSummary(response.length),
  };
}

function completeSoftwareOperationBatchSummary(
  itemCount: number,
  summary?: Partial<SoftwareOperationBatchResponse["summary"]>,
): SoftwareOperationBatchResponse["summary"] {
  return {
    inputCount: summary?.inputCount ?? itemCount,
    nonEmptyCount: summary?.nonEmptyCount ?? itemCount,
    uniqueSpecCount: summary?.uniqueSpecCount ?? itemCount,
    ignoredEmptyCount: summary?.ignoredEmptyCount ?? 0,
    ignoredDuplicateCount: summary?.ignoredDuplicateCount ?? 0,
  };
}

function mergeSoftwareOperationHistoryIntoCachedQueries(
  queryClient: QueryClient,
  agentId: string,
  incoming: SoftwareOperation[],
) {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: [...OPERATIONS_KEY, agentId] })) {
    const matching = incoming.filter((operation) =>
      softwareOperationMatchesQueryKey(operation, query.queryKey),
    );
    if (matching.length === 0) continue;
    queryClient.setQueryData<SoftwareOperation[]>(query.queryKey, (current) =>
      mergeSoftwareOperationHistory(current, matching),
    );
  }
}
