import { useMutation, useQuery } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import {
  type ActiveAgentRegistrationToken,
  type AgentRegistrationContext,
  type AgentRegistrationToken,
  type AgentRegistrationTokenCreate,
  createAgentRegistrationToken,
  getAgentRegistrationContext,
  listActiveAgentRegistrationTokens,
  revokeAgentRegistrationToken,
} from "./cp-client";

export function useAgentRegistrationContext() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<AgentRegistrationContext, Error>({
    queryKey: ["cp", "agent-registration-context", activeOrganizationId ?? "all"],
    queryFn: getAgentRegistrationContext,
  });
}

export function useActiveAgentRegistrationTokens() {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<ActiveAgentRegistrationToken[], Error>({
    queryKey: ["cp", "agent-registration-tokens", activeOrganizationId ?? "all"],
    queryFn: listActiveAgentRegistrationTokens,
  });
}

export function useCreateAgentRegistrationToken() {
  return useMutation<AgentRegistrationToken, Error, AgentRegistrationTokenCreate>({
    mutationFn: (payload) => createAgentRegistrationToken(payload),
  });
}

export function useRevokeAgentRegistrationToken() {
  return useMutation<void, Error, string>({
    mutationFn: (id) => revokeAgentRegistrationToken(id),
  });
}
