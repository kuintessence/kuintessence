import { ApiError } from "./api-client";

/** Map a thrown error into a clean, actionable top-level CLI message. Auth
 *  failures become a hint to log in (or use the all-in-one `--local` mode)
 *  rather than a raw status/code, since "run `kq list`" without `kq login`
 *  is the most common first-use stumble. Pure + exported for testing. */
export function formatCliError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return "Not authenticated — run `kq login` first, or use the all-in-one local mode (e.g. `kq list --local`, `kq tui --local`).";
    }
    if (err.status === 403) {
      return `Access denied (403) — you may lack permission for this resource: ${err.message}`;
    }
    return `API error (${err.status}, ${err.code}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
