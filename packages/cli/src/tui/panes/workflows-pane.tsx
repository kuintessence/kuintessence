import type { TuiWorkflowRun } from "../backend/types";
import { formatAge, padCell, statusColor, statusGlyph, summarizeStatuses } from "../format";
import { Box, Text } from "../opentui";
import { pinnedItem, type TuiState, visibleWorkflows } from "../store";
import { DEFAULT_VIEWPORT_ROWS, windowRows } from "../viewport";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

const COLS = { id: 16, name: 26, status: 12, age: 6 } as const;

function WorkflowRow({
  run,
  selected,
  now,
}: {
  run: TuiWorkflowRun;
  selected: boolean;
  now: number;
}) {
  return (
    <Text inverse={selected}>
      <Text color={statusColor(run.status)}>{statusGlyph(run.status)} </Text>
      {padCell(run.id, COLS.id)} {padCell(run.name, COLS.name)}{" "}
      <Text color={statusColor(run.status)}>{padCell(run.status, COLS.status)}</Text>{" "}
      {padCell(formatAge(run.createdAt, now), COLS.age)}
    </Text>
  );
}

/** Pure presentational workflow-runs pane (Server-only). */
export function WorkflowsPane({
  state,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
}: {
  state: TuiState;
  viewportRows?: number;
}) {
  const now = Date.now();
  const workflows = visibleWorkflows(state);
  const selected = pinnedItem(workflows, state.detailId, state.selectedIndex);

  if (state.view === "detail" && selected) {
    const { loading, error, data } = state.wfDetail;
    return (
      <Box flexDirection="column">
        <Text bold>Workflow run {selected.id}</Text>
        <Text>
          Name: <Text color="cyan">{selected.name}</Text>
        </Text>
        <Text>
          Status: <Text color={statusColor(selected.status)}>{selected.status}</Text>
        </Text>
        <Text>Created: {selected.createdAt ?? "—"}</Text>
        {data?.description ? <Text>Description: {data.description}</Text> : null}
        <Box marginTop={1} flexDirection="column">
          <Text bold color="gray">
            Steps:
            {data && data.steps.length > 0 ? (
              <Text> {summarizeStatuses(data.steps.map((s) => s.status || "pending"))}</Text>
            ) : null}
          </Text>
          {loading ? <Text color="gray">Loading steps…</Text> : null}
          {error ? <Text color="red">Error: {error}</Text> : null}
          {data && data.steps.length === 0 ? <Text color="gray">(no steps)</Text> : null}
          {data?.steps.map((step) => {
            // A status glyph (coloured) makes a failed/running step pop in a
            // long tree; fall back to a bullet for empty/unknown statuses.
            const glyph = step.status ? statusGlyph(step.status) : "•";
            const marker = glyph === "?" ? "•" : glyph;
            return (
              <Text key={step.id}>
                {"  "}
                <Text color={statusColor(step.status)}>{marker}</Text> {step.id}
                {step.status ? <Text color="gray"> [{step.status}]</Text> : null}
                {step.info ? <Text color="gray"> {step.info}</Text> : null}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (state.loading && state.workflows.length === 0) {
    return <Text color="gray">Loading workflow runs…</Text>;
  }
  if (state.error && workflows.length === 0) {
    return <Text color="red">Error: {state.error}</Text>;
  }
  if (workflows.length === 0) {
    return (
      <Text color="gray">
        {state.filter ? `No workflow runs match "${state.filter}".` : "No workflow runs yet."}
      </Text>
    );
  }

  const win = windowRows(workflows, state.selectedIndex, viewportRows);
  return (
    <Box flexDirection="column">
      <Text color="gray">{summarizeStatuses(workflows.map((w) => w.status))}</Text>
      <Text bold color="gray">
        {"  "}
        {padCell("RUN ID", COLS.id)} {padCell("NAME", COLS.name)} {padCell("STATUS", COLS.status)}{" "}
        {padCell("AGE", COLS.age)}
      </Text>
      <ErrorBanner error={state.error} />
      <ScrollHint count={win.hiddenAbove} direction="up" />
      {win.rows.map((run, i) => (
        <WorkflowRow
          key={run.id}
          run={run}
          selected={win.startIndex + i === state.selectedIndex}
          now={now}
        />
      ))}
      <ScrollHint count={win.hiddenBelow} direction="down" />
    </Box>
  );
}
