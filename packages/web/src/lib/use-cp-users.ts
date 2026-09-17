import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrganizationId } from "./active-organization";
import {
  type CpUsersPage,
  type ListUsersQuery,
  listUsers,
  setUserQuota,
  setUserSuspended,
} from "./cp-client";

const ROOT_KEY = ["cp", "users"] as const;

export function useCpUsers(q: ListUsersQuery) {
  const activeOrganizationId = useActiveOrganizationId();
  return useQuery<CpUsersPage>({
    queryKey: [
      ...ROOT_KEY,
      activeOrganizationId ?? "all",
      q.search ?? "",
      q.limit ?? 50,
      q.offset ?? 0,
    ] as const,
    queryFn: () => listUsers(q),
    enabled: activeOrganizationId !== null,
  });
}

export function useCpSetUserSuspended() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: string; suspended: boolean }>({
    mutationFn: ({ userId, suspended }) => setUserSuspended(userId, suspended),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROOT_KEY });
    },
  });
}

export function useCpSetUserQuota() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: string; quota: number }>({
    mutationFn: ({ userId, quota }) => setUserQuota(userId, quota),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROOT_KEY });
    },
  });
}
