import { ApiError } from "@kuintessence/shared/browser";

const POLICY_KEY = "kq.mobile-management-policy";
const HIGH_RISK_PATHS = [
  /^\/admin(?:\/|$)/,
  /^\/agent-registration(?:\/|$)/,
  /^\/agents\/[^/]+\/certs(?:\/|$)/,
  /^\/cp(?:\/|$)/,
  /^\/sandbox\/policies(?:\/|$)/,
  /^\/software(?:\/|$)/,
  /^\/storage\/(?:policies|allocations|quotas)(?:\/|$)/,
];
const APPROVAL_PATHS = [/(?:\/|^)(?:approve|approval|review|requests?)(?:\/|$)/];

export function setMobileManagementPolicy(enabled: boolean): void {
  try {
    if (enabled) sessionStorage.setItem(POLICY_KEY, "observe-approve");
    else sessionStorage.removeItem(POLICY_KEY);
  } catch {
    // A blocked sessionStorage must not make the capability request fail.
  }
}

export function isCompactViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

export function isMobileHighRiskMutationBlocked(path: string): boolean {
  if (!isCompactViewport()) return false;
  try {
    if (sessionStorage.getItem(POLICY_KEY) !== "observe-approve") return false;
  } catch {
    return false;
  }
  if (APPROVAL_PATHS.some((pattern) => pattern.test(path))) return false;
  return HIGH_RISK_PATHS.some((pattern) => pattern.test(path));
}

export function assertMobileMutationAllowed(path: string): void {
  if (!isMobileHighRiskMutationBlocked(path)) return;
  throw new ApiError(
    403,
    "MOBILE_HIGH_RISK_MUTATION_BLOCKED",
    "This high-risk change is available on desktop only",
  );
}
