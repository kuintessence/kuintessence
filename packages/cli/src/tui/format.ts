/** A glyph for each status, for the leftmost table column. Accepts any string
 *  (workflow step statuses are engine-specific) — unknown values get "?". */
export function statusGlyph(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    case "queued":
      return "○";
    default:
      return "?";
  }
}

/** An OpenTUI colour name for each status. Accepts any string; unknown → white. */
export function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "green";
    case "completed":
      return "cyan";
    case "failed":
      return "red";
    case "cancelled":
      return "yellow";
    case "queued":
      return "gray";
    default:
      return "white";
  }
}

/**
 * Compact relative age ("2m", "3h", "5d") between two epoch-ms instants.
 * Clamps sub-second/future deltas to "0s". `now` is injected for determinism.
 */
export function ageFromMs(thenMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * Job run time: `startedAt` → `completedAt` (finished) or → `now` (still
 * running). Undefined when there's no parseable start, or the end precedes the
 * start. `now` is injected for deterministic tests.
 */
export function jobElapsed(
  startedAt: string | undefined,
  completedAt: string | undefined,
  now: number,
): string | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return undefined;
  const parsedEnd = completedAt ? Date.parse(completedAt) : now;
  const end = Number.isNaN(parsedEnd) ? now : parsedEnd;
  if (end < start) return undefined;
  return ageFromMs(start, end);
}

/**
 * Compact human duration for a span given in seconds ("45s", "1m30s", "1h30m",
 * "1d1h"). Renders the two most-significant non-zero units; non-positive input
 * is "0s". Used to surface a job's wall-time limit in detail.
 */
export function formatDuration(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  if (sec === 0) return "0s";
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = sec;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
  }
  return parts.slice(0, 2).join("");
}

/**
 * Compact relative age from an ISO/parseable timestamp. Returns "—" for
 * missing/unparseable input; otherwise delegates to {@link ageFromMs}.
 */
export function formatAge(submittedAt: string | undefined, now: number): string {
  if (!submittedAt) return "—";
  const then = Date.parse(submittedAt);
  if (Number.isNaN(then)) return "—";
  return ageFromMs(then, now);
}

/** Turn a caught error into a user-facing message. An auth failure (HTTP
 *  401/403 from the API client's ApiError, which carries a `status`) becomes an
 *  actionable hint instead of a raw status — common when a JWT expires during a
 *  long monitoring session. Otherwise the error's own message (or string form). */
export function friendlyError(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status: unknown }).status
      : undefined;
  if (status === 401) return "Session expired — run `kq login` to re-authenticate.";
  if (status === 403) return "Access denied (403) — you may lack permission for this resource.";
  if (err instanceof Error) return err.message;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Case-insensitive substring grep over log lines. An empty needle is a no-op
 *  (returns every line), so callers can pass the live search term directly. */
export function grepLines(lines: string[], needle: string): string[] {
  if (!needle) return lines;
  const lower = needle.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(lower));
}

/** Compact "time since last heartbeat" for an agent ("3d", "5m"), or "—" when
 *  never reported / unparseable. Used by the Agents list + Metrics pane so a
 *  stale agent's data is recognisable. */
export function seenLabel(lastHeartbeat: string | undefined, now: number): string {
  if (!lastHeartbeat) return "—";
  const ms = Date.parse(lastHeartbeat);
  return Number.isNaN(ms) ? "—" : ageFromMs(ms, now);
}

const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

/** Render a series of values as a unicode block sparkline (one char per
 *  sample), each mapped to one of 8 levels by its proportion of `max`. Empty
 *  input → empty string; out-of-range values clamp. Used for per-agent metric
 *  trends in the Metrics pane. */
export function sparkline(values: number[], max: number): string {
  if (values.length === 0 || max <= 0) return "";
  return values
    .map((v) => {
      const ratio = Math.max(0, Math.min(1, v / max));
      const idx = Math.round(ratio * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[idx] ?? SPARK_BLOCKS[0];
    })
    .join("");
}

/** Truncate to `width`, marking elision with a trailing "…". */
export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

/** Pad (or truncate) to an exact column width for monospace table alignment. */
export function padCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
}

/** Status names that lead a summary line, in triage order; any other status
 *  follows alphabetically. */
const STATUS_ORDER: readonly string[] = ["running", "queued", "completed", "failed", "cancelled"];

/**
 * A compact "N total · a running · b queued · …" summary for a list-pane
 * header — lets a user triage a long queue without counting glyphs by eye.
 * Known statuses lead in {@link STATUS_ORDER}; unknown ones follow
 * alphabetically. Only non-zero statuses are shown.
 */
export function summarizeStatuses(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  const ranked = [...counts.keys()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
    return a.localeCompare(b);
  });
  const parts = ranked.map((s) => `${counts.get(s)} ${s}`);
  return [`${statuses.length} total`, ...parts].join(" · ");
}

/**
 * A fixed-width ASCII meter for a value in [0, max]: filled blocks for the
 * proportion, light blocks for the remainder. Out-of-range inputs clamp to
 * [0, width]; max<=0 renders empty. Used by the Metrics pane.
 */
export function asciiBar(value: number, max: number, width: number): string {
  if (width <= 0) return "";
  const ratio = max > 0 ? value / max : 0;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
