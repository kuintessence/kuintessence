/** Cancel each id via the injected canceller, tallying successes and the ids
 *  that failed — one bad id must not abort the rest of a bulk cancel. Pure given
 *  `cancel`; the app wires it to `backend.cancelJob`. */
export async function cancelEach(
  cancel: (id: string) => Promise<void>,
  ids: readonly string[],
): Promise<{ ok: number; failed: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await cancel(id);
      ok++;
    } catch {
      failed.push(id);
    }
  }
  return { ok, failed };
}

/** One-line footer notice summarising a bulk cancel (pluralized; lists failed
 *  ids when any). */
export function bulkCancelNotice(ok: number, failed: readonly string[]): string {
  return failed.length > 0
    ? `Cancelled ${ok}, failed ${failed.length} (${failed.join(", ")})`
    : `Cancelled ${ok} marked job${ok === 1 ? "" : "s"}`;
}
