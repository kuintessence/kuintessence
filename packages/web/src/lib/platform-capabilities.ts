import {
  type MeCapabilities,
  MeCapabilitiesSchema,
  type PlatformCapability,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useActiveOrganizationId } from "./active-organization";
import { api } from "./api-client";
import { getAuthState } from "./auth";
import { isLocalMode } from "./local-mode";
import { setMobileManagementPolicy } from "./mobile-management-policy";

export type CapabilityLoadState =
  | { status: "idle" | "loading"; data: null; error: null }
  | { status: "ready"; data: MeCapabilities; error: null }
  | { status: "error"; data: null; error: Error };

export function useMeCapabilities(enabled: boolean) {
  const queryClient = useQueryClient();
  const auth = getAuthState();
  const identity = `${auth.email ?? "anonymous"}:${auth.revision ?? "legacy"}`;
  const activeOrganizationId = useActiveOrganizationId(enabled);
  const query = useQuery({
    queryKey: ["me", "capabilities", identity, activeOrganizationId ?? "all"],
    queryFn: async () => MeCapabilitiesSchema.parse(await api.get<unknown>("/me/capabilities")),
    enabled,
    retry: false,
  });

  useEffect(() => {
    if (!enabled) {
      setMobileManagementPolicy(false);
      return;
    }
    if (query.data) {
      setMobileManagementPolicy(query.data.devicePolicy.mobileMode === "observe-approve");
    }
  }, [enabled, query.data]);

  useEffect(() => {
    if (!enabled) return;
    const reload = () => {
      queryClient.removeQueries({ queryKey: ["me", "capabilities"] });
    };
    window.addEventListener("kq:active-organization-change", reload);
    return () => window.removeEventListener("kq:active-organization-change", reload);
  }, [enabled, queryClient]);

  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);
  if (!enabled) return { status: "idle", data: null, error: null, retry } as const;
  if (query.isPending) return { status: "loading", data: null, error: null, retry } as const;
  if (query.error) {
    return {
      status: "error",
      data: null,
      error: query.error instanceof Error ? query.error : new Error("Unable to load capabilities"),
      retry,
    } as const;
  }
  return { status: "ready", data: query.data, error: null, retry } as const;
}

export function toCapabilitySet(data: MeCapabilities | null): ReadonlySet<PlatformCapability> {
  return new Set(data?.capabilities ?? []);
}

export function usePlatformCapability(capability: PlatformCapability): {
  allowed: boolean;
  ready: boolean;
  error: Error | null;
  retry: () => void;
} {
  const auth = getAuthState();
  const local = isLocalMode();
  const state = useMeCapabilities(auth.isAuthenticated && !local);
  return {
    allowed: !local && state.status === "ready" && toCapabilitySet(state.data).has(capability),
    ready: local || state.status === "ready" || state.status === "error",
    error: state.error,
    retry: state.retry,
  };
}
