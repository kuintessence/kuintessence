import { isMobileHighRiskMutationBlocked } from "./mobile-management-policy";
import { useMediaQuery } from "./use-media-query";

export function useMobileMutationBlocked(path: string): boolean {
  const compact = useMediaQuery("(max-width: 767px)");
  return compact && isMobileHighRiskMutationBlocked(path);
}
