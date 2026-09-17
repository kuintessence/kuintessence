import type {
  QueueInventoryAdminView,
  QueueRegistryCreate,
  QueueRegistryUpdate,
  QueueRegistryView,
} from "@kuintessence/shared/browser";
import {
  QueueInventoryAdminViewSchema,
  QueueRegistryViewSchema,
} from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import { api } from "./api-client";

const queueKey = ["cp", "queues"] as const;
const inventoryKey = ["cp", "queue-inventory"] as const;

function parseQueueList(body: unknown): QueueRegistryView[] {
  if (typeof body !== "object" || body === null || !("queues" in body)) {
    throw new Error("Queue list response is invalid");
  }
  return QueueRegistryViewSchema.array().parse(body.queues);
}

export async function listCpQueues(): Promise<QueueRegistryView[]> {
  return parseQueueList(await api.get<unknown>("/admin/queues"));
}

export async function getCpQueueInventory(agentId: string): Promise<QueueInventoryAdminView> {
  return QueueInventoryAdminViewSchema.parse(
    await api.get<unknown>(`/admin/agents/${encodeURIComponent(agentId)}/queue-inventory`),
  );
}

export async function createCpQueue(payload: QueueRegistryCreate): Promise<QueueRegistryView> {
  return api.post<QueueRegistryView>("/admin/queues", payload);
}

export async function updateCpQueue(
  queueId: string,
  patch: QueueRegistryUpdate,
): Promise<QueueRegistryView> {
  return api.patch<QueueRegistryView>(`/admin/queues/${encodeURIComponent(queueId)}`, patch);
}

export function useCpQueues() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery({
    queryKey: [...queueKey, activeOrganizationId ?? "all"],
    queryFn: listCpQueues,
  });
}

export function useCpQueueInventory(agentId: string | null, enabled = true) {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery({
    queryKey: [...inventoryKey, activeOrganizationId ?? "all", agentId],
    queryFn: () => getCpQueueInventory(agentId ?? ""),
    enabled: enabled && Boolean(agentId),
    retry: false,
  });
}

export function useCreateCpQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCpQueue,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queueKey }),
        queryClient.invalidateQueries({ queryKey: inventoryKey }),
      ]);
    },
  });
}

export function useUpdateCpQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ queueId, patch }: { queueId: string; patch: QueueRegistryUpdate }) =>
      updateCpQueue(queueId, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queueKey }),
        queryClient.invalidateQueries({ queryKey: inventoryKey }),
      ]);
    },
  });
}
