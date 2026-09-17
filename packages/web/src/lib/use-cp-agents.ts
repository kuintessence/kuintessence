import type { ClusterFileRootView } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import { api } from "./api-client";
import {
  type CpAgent,
  type CpAgentCert,
  listAgents,
  listCpAgentCerts,
  revokeCpAgentCert,
} from "./cp-client";

interface ClusterFileRootsResponse {
  roots: ClusterFileRootView[];
}

export function useCpAgents() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<CpAgent[]>({
    queryKey: ["cp", "agents", activeOrganizationId ?? "all"],
    queryFn: () => listAgents(),
    refetchInterval: 30_000,
  });
}

export function useCpAgentCerts(agentId: string | null) {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<CpAgentCert[]>({
    queryKey: ["cp", "agents", activeOrganizationId ?? "all", agentId, "certs"],
    queryFn: () => listCpAgentCerts(agentId ?? ""),
    enabled: !!agentId,
  });
}

export function useCpAgentClusterFileRoots(agentId: string | null) {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<ClusterFileRootView[]>({
    queryKey: ["cp", "agents", activeOrganizationId ?? "all", agentId, "cluster-file-roots"],
    queryFn: async () => {
      const res = await api.get<ClusterFileRootsResponse>("/admin/cluster-file-roots");
      return res.roots
        .filter((root) => root.agentId === null || root.agentId === agentId)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.path.localeCompare(b.path));
    },
    enabled: !!agentId,
  });
}

export function useRevokeCpAgentCert() {
  const queryClient = useQueryClient();
  const activeOrganizationId = useActiveOrganizationId();
  return useMutation<void, Error, { agentId: string; fingerprintSha256: string; reason?: string }>({
    mutationFn: ({ agentId, fingerprintSha256, reason }) =>
      revokeCpAgentCert(agentId, fingerprintSha256, reason),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["cp", "agents", activeOrganizationId ?? "all", variables.agentId, "certs"],
      });
    },
  });
}
