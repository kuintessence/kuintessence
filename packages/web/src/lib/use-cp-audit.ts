import { useMutation } from "@tanstack/react-query";
import { type AuditSearchPage, type AuditSearchQuery, searchAudit } from "./cp-client";

/**
 * Audit search is a one-shot mutation rather than a passive query because
 * the user explicitly drives the request via form submit and we don't want
 * to fire requests on filter mutations until they hit "Search".
 */
export function useCpSearchAudit() {
  return useMutation<AuditSearchPage, Error, AuditSearchQuery>({
    mutationFn: (q) => searchAudit(q),
  });
}
