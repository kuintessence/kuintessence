import type { TuiBackendInfo, TuiJob } from "../backend/types";
import {
  formatAge,
  formatDuration,
  jobElapsed,
  padCell,
  statusColor,
  statusGlyph,
  summarizeStatuses,
} from "../format";
import { Box, Text } from "../opentui";
import { pinnedItem, type TuiState, visibleJobs } from "../store";
import { DEFAULT_VIEWPORT_ROWS, windowRows } from "../viewport";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

const COLS = { id: 14, name: 22, status: 11, loc: 12, age: 6 } as const;

function JobRow({
  jobItem,
  selected,
  marked,
  now,
}: {
  jobItem: TuiJob;
  selected: boolean;
  marked: boolean;
  now: number;
}) {
  return (
    <Text inverse={selected}>
      <Text color="yellow">{marked ? "◉" : " "}</Text>
      <Text color={statusColor(jobItem.status)}>{statusGlyph(jobItem.status)} </Text>
      {padCell(jobItem.id, COLS.id)} {padCell(jobItem.name, COLS.name)}{" "}
      <Text color={statusColor(jobItem.status)}>{padCell(jobItem.status, COLS.status)}</Text>{" "}
      {padCell(jobItem.location, COLS.loc)} {padCell(formatAge(jobItem.submittedAt, now), COLS.age)}
    </Text>
  );
}

function JobDetail({
  jobItem,
  detail,
  now,
}: {
  jobItem: TuiJob;
  detail: TuiState["jobDetail"];
  now: number;
}) {
  const d = detail.data;
  // Enriched status overrides the (older) list-row status once fetched.
  const status = d?.status ?? jobItem.status;
  const elapsed = jobElapsed(d?.startedAt, d?.completedAt, now);
  // Queue wait: submit → start (or → now while still pending). Reuses the same
  // span helper, treating submittedAt as start and startedAt as the end.
  const queued = jobElapsed(jobItem.submittedAt, d?.startedAt, now);
  return (
    <Box flexDirection="column">
      <Text bold>Job {jobItem.id}</Text>
      <Text>
        Name: <Text color="cyan">{jobItem.name}</Text>
      </Text>
      <Text>
        Status: <Text color={statusColor(status)}>{status}</Text>
        {detail.live ? <Text color="green"> ●live</Text> : null}
        {detail.loading ? <Text color="gray"> (refreshing…)</Text> : null}
      </Text>
      {d?.reason ? (
        <Text>
          Reason: <Text color="yellow">{d.reason}</Text>
        </Text>
      ) : null}
      <Text>Location: {jobItem.location}</Text>
      <Text>Submitted: {jobItem.submittedAt ?? "—"}</Text>
      {queued ? <Text>Queued: {queued}</Text> : null}
      {d?.schedulerJobId ? <Text>Scheduler ID: {d.schedulerJobId}</Text> : null}
      {d?.cpus !== undefined && d?.memoryMb !== undefined ? (
        <Text>
          Requested: {d.cpus} CPU · {(d.memoryMb / 1024).toFixed(1)} GiB
          {d.gpus ? ` · ${d.gpus} GPU` : ""}
        </Text>
      ) : null}
      {d?.wallTimeSec ? <Text>Time limit: {formatDuration(d.wallTimeSec)}</Text> : null}
      {d?.command ? <Text color="gray">Command: {d.command}</Text> : null}
      {d?.node ? <Text>Node: {d.node}</Text> : null}
      {d?.startedAt ? <Text>Started: {d.startedAt}</Text> : null}
      {elapsed ? <Text>Elapsed: {elapsed}</Text> : null}
      {d?.completedAt ? <Text>Completed: {d.completedAt}</Text> : null}
      {d?.exitCode !== undefined ? <Text>Exit code: {d.exitCode}</Text> : null}
      {d?.message ? <Text color="gray">{d.message}</Text> : null}
      {detail.error ? <Text color="red">Detail error: {detail.error}</Text> : null}
    </Box>
  );
}

/** Pure presentational jobs pane — list table or single-job detail, driven
 *  entirely by {@link TuiState}. No I/O, so it renders identically for the
 *  remote and local backends. */
export function JobsPane({
  state,
  mode,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
}: {
  state: TuiState;
  mode: TuiBackendInfo["mode"];
  viewportRows?: number;
}) {
  const now = Date.now();
  const jobs = visibleJobs(state);
  const selected = pinnedItem(jobs, state.detailId, state.selectedIndex);

  if (state.view === "detail" && selected) {
    return <JobDetail jobItem={selected} detail={state.jobDetail} now={now} />;
  }

  if (state.loading && state.jobs.length === 0) {
    return <Text color="gray">Loading jobs…</Text>;
  }
  if (state.error && jobs.length === 0) {
    return <Text color="red">Error: {state.error}</Text>;
  }
  if (jobs.length === 0) {
    if (state.filter) {
      return <Text color="gray">No jobs match "{state.filter}".</Text>;
    }
    return (
      <Text color="gray">
        No jobs found{mode === "local" ? " in the local scheduler queue." : "."}
      </Text>
    );
  }

  const win = windowRows(jobs, state.selectedIndex, viewportRows);
  return (
    <Box flexDirection="column">
      <Text color="gray">
        {summarizeStatuses(jobs.map((j) => j.status))}
        {state.marked.size > 0 ? ` · ${state.marked.size} marked` : ""}
      </Text>
      <Text bold color="gray">
        {"   "}
        {padCell("ID", COLS.id)} {padCell("NAME", COLS.name)} {padCell("STATUS", COLS.status)}{" "}
        {padCell("LOCATION", COLS.loc)} {padCell("AGE", COLS.age)}
      </Text>
      <ErrorBanner error={state.error} />
      <ScrollHint count={win.hiddenAbove} direction="up" />
      {win.rows.map((jobItem, i) => (
        <JobRow
          key={jobItem.id}
          jobItem={jobItem}
          selected={win.startIndex + i === state.selectedIndex}
          marked={state.marked.has(jobItem.id)}
          now={now}
        />
      ))}
      <ScrollHint count={win.hiddenBelow} direction="down" />
    </Box>
  );
}
