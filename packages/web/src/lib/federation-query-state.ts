import { ApiError } from "@kuintessence/shared/browser";

export function federationReadFailed(query: {
  isError: boolean;
  error: unknown;
  data: unknown;
}): boolean {
  if (!query.isError) return false;
  if (query.data === undefined) return true;
  // Authorization, scope and schema failures must never retain a previously readable view.
  return !(
    query.error instanceof TypeError ||
    (query.error instanceof ApiError && query.error.status >= 500)
  );
}
