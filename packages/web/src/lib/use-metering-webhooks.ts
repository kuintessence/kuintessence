import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api-client";

export interface MeteringWebhook {
  id: string;
  orgId: string;
  url: string;
  enabled: boolean;
  events: string[];
  failures: number;
  createdAt: string;
}

export interface CreateWebhookInput {
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
}

export function useMeteringWebhooks(organizationId: string | null = null) {
  return useQuery<MeteringWebhook[]>({
    queryKey: ["metering", "webhooks", organizationId],
    queryFn: async () => (await api.get<{ items: MeteringWebhook[] }>("/metering/webhook")).items,
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) => api.post<{ id: string }>("/metering/webhook", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["metering", "webhooks"] }),
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/metering/webhook/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["metering", "webhooks"] }),
  });
}
