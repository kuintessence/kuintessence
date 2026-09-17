import { getAuthState } from "./auth";
import { isLocalMode } from "./local-mode";
import { toCapabilitySet, useMeCapabilities } from "./platform-capabilities";

export function useSoftwarePublishingAccess(): {
  canPublish: boolean;
  ready: boolean;
  error: Error | null;
  retry: () => void;
} {
  const auth = getAuthState();
  const local = isLocalMode();
  const capabilityState = useMeCapabilities(auth.isAuthenticated && !local);
  return {
    canPublish:
      !local &&
      capabilityState.status === "ready" &&
      toCapabilitySet(capabilityState.data).has("software.publish"),
    ready: local || capabilityState.status === "ready" || capabilityState.status === "error",
    error: capabilityState.error,
    retry: capabilityState.retry,
  };
}
