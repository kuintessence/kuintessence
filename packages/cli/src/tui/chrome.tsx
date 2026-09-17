import { KQ_VERSION } from "../version";
import type { TuiBackend } from "./backend/types";
import { ageFromMs } from "./format";
import { Box, Text } from "./opentui";
import { isPaneEnabled, PANE_ORDER, type PaneId, type SortKey } from "./store";

/** Top tab bar + connection target. */
export function Header({ backend, pane }: { backend: TuiBackend; pane: PaneId }) {
  return (
    <Box justifyContent="space-between">
      <Box>
        {PANE_ORDER.map((p, i) => {
          const enabled = isPaneEnabled(p, backend.capabilities);
          const label = p.charAt(0).toUpperCase() + p.slice(1);
          return (
            <Text
              key={p}
              color={p === pane ? "black" : enabled ? "white" : "gray"}
              backgroundColor={p === pane ? "cyan" : undefined}
              dimColor={!enabled}
            >
              {` ${i + 1}:${label} `}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">
        {backend.info.mode === "local" ? "local" : "remote"}:{backend.info.target}
      </Text>
    </Box>
  );
}

/** Context-sensitive keybinding hint line + transient notice. */
export function Footer({
  notice,
  view,
  pane,
  canSubmit,
  canWorkflows,
  canLogs,
  canSsh,
  sortKey,
  lastUpdatedAt,
  now,
}: {
  notice: string | undefined;
  view: "list" | "detail" | "logs";
  pane: PaneId;
  canSubmit: boolean;
  canWorkflows: boolean;
  canLogs: boolean;
  canSsh: boolean;
  sortKey: SortKey;
  /** Epoch-ms of the last successful pane load; undefined before the first
   *  one. Drives the "updated Xs ago" freshness hint so a stalled poll is
   *  visible. */
  lastUpdatedAt?: number;
  now?: number;
}) {
  const cancel = pane === "jobs" ? " · x cancel" : "";
  const mark = pane === "jobs" ? " · space mark" : "";
  const canSubmitHere = (pane === "jobs" && canSubmit) || (pane === "workflows" && canWorkflows);
  const submit = canSubmitHere ? " · s submit" : "";
  const logs = canLogs && pane === "jobs" ? " · l logs" : "";
  const ssh = canSsh && pane === "agents" ? " · c ssh" : "";
  const catalogPages = pane === "software" ? " · [ prev · ] next" : "";
  const sort = sortKey === "default" ? "o sort" : `o sort:${sortKey}`;
  let keys: string;
  if (view === "logs") {
    keys = `esc back · f follow · r re-tail · q quit`;
  } else if (view === "detail") {
    keys = `esc back${cancel} · q quit`;
  } else {
    keys = `↑/↓ select · enter detail${cancel}${mark}${submit}${logs}${ssh}${catalogPages} · / filter · ${sort} · tab pane · ? help · q quit`;
  }
  const freshness =
    lastUpdatedAt !== undefined && now !== undefined
      ? ` · updated ${ageFromMs(lastUpdatedAt, now)} ago`
      : "";
  return (
    <Box flexDirection="column">
      {notice ? <Text color="yellow">{notice}</Text> : null}
      <Text color="gray">
        {keys}
        {freshness}
      </Text>
    </Box>
  );
}

/** The `/` filter query indicator. */
export function FilterBar({ filter, filtering }: { filter: string; filtering: boolean }) {
  if (!filtering && !filter) return null;
  return (
    <Text color={filtering ? "cyan" : "gray"}>
      /{filter}
      {filtering ? "▌" : ""}
      {filtering ? "  (enter apply · esc clear)" : "  (esc clear)"}
    </Text>
  );
}

/** Full keybinding reference (toggled with `?`). Capability-aware: keys that do
 *  nothing in the active mode (SSH/logs in a bare local node, workflow submit
 *  without a Server) are hidden so the help matches what actually works — mirrors
 *  the {@link Footer}'s context-sensitive hint line. */
export function HelpOverlay({
  mode,
  canLogs,
  canSsh,
  canWorkflows,
}: {
  mode: "remote" | "local";
  canLogs: boolean;
  canSsh: boolean;
  canWorkflows: boolean;
}) {
  const submitDesc = canWorkflows
    ? "submit a job/workflow from a file"
    : "submit a job from a file";
  const rows: Array<[string, string]> = [
    ["↑/↓ or j/k", "move selection"],
    ["g / G", "jump to top / bottom"],
    ["PgUp/PgDn ^u/^d", "page up / down"],
    ["enter", "open detail (not metrics)"],
    ["esc", "back · clear filter · close overlay"],
    ["tab", "next pane"],
    ["1–5", "jump to pane by number"],
    ["/", "filter list · grep logs (in logs view)"],
    ["o", "cycle sort (default → name → status)"],
    ["r", "refresh (re-tail in logs view)"],
    ["[ / ]", "previous / next Software catalog page"],
    ["s", submitDesc],
    ["space", "mark/unmark job for bulk action (jobs)"],
    ["x", "cancel selected — or all marked — jobs (asks to confirm)"],
    ...(canLogs ? ([["l", "view job logs (jobs)"]] as Array<[string, string]>) : []),
    ["f", "toggle live follow (logs view)"],
    ["j/k g/G PgUp/Dn", "scroll logs (in logs view)"],
    ...(canSsh
      ? ([["c", "open an SSH shell to the agent (agents)"]] as Array<[string, string]>)
      : []),
    ["q", "quit"],
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        kq tui v{KQ_VERSION} — keybindings ({mode} mode)
      </Text>
      {rows.map(([k, desc]) => (
        <Text key={k}>
          <Text color="yellow">{k.padEnd(16, " ")}</Text> {desc}
        </Text>
      ))}
      <Text color="gray">
        Panes: Jobs · Workflows · Agents · Metrics · Software (Server-only panes are disabled in
        local mode). Press ? or esc to close.
      </Text>
    </Box>
  );
}

/** y/n confirmation overlay for a destructive job cancel — single job, or a
 *  bulk cancel of N marked jobs when `bulkCount` is set. */
export function ConfirmPrompt({
  jobId,
  jobName,
  bulkCount,
}: {
  jobId: string;
  jobName: string;
  bulkCount?: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">
        {bulkCount !== undefined
          ? `Cancel ${bulkCount} marked job${bulkCount === 1 ? "" : "s"}?`
          : `Cancel job ${jobName} (${jobId})?`}
      </Text>
      <Text color="gray">y confirm · n / esc dismiss</Text>
    </Box>
  );
}

/** Single-line file-path prompt for submitting a job (JSON) or workflow (YAML). */
export function SubmitForm({
  path,
  submitting,
  kind,
}: {
  path: string;
  submitting: boolean;
  kind: "job" | "workflow";
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {kind === "workflow" ? "Submit workflow from YAML file" : "Submit job from spec file"}
      </Text>
      <Text>
        Path: {path}
        {submitting ? "" : "▌"}
      </Text>
      <Text color="gray">{submitting ? "submitting…" : "enter submit · esc cancel"}</Text>
    </Box>
  );
}
