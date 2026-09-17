import type { TuiAgent } from "../backend/types";
import {
  ageFromMs,
  padCell,
  seenLabel,
  statusColor,
  statusGlyph,
  summarizeStatuses,
} from "../format";
import { Box, Text } from "../opentui";
import { pinnedItem, type TuiState, visibleAgents } from "../store";
import { DEFAULT_VIEWPORT_ROWS, windowRows } from "../viewport";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

const COLS = { id: 18, site: 16, sched: 16, status: 10, seen: 7 } as const;

function AgentRow({ agent, selected, now }: { agent: TuiAgent; selected: boolean; now: number }) {
  return (
    <Text inverse={selected}>
      <Text color={statusColor(agent.status)}>{statusGlyph(agent.status)} </Text>
      {padCell(agent.id, COLS.id)} {padCell(agent.site, COLS.site)}{" "}
      {padCell(agent.scheduler, COLS.sched)}{" "}
      <Text color={statusColor(agent.status)}>{padCell(agent.status, COLS.status)}</Text>{" "}
      {padCell(seenLabel(agent.lastHeartbeat, now), COLS.seen)}
    </Text>
  );
}

/** Pure presentational agents pane (Server-only). */
export function AgentsPane({
  state,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
}: {
  state: TuiState;
  viewportRows?: number;
}) {
  const agents = visibleAgents(state);
  const selected = pinnedItem(agents, state.detailId, state.selectedIndex);

  if (state.view === "detail" && selected) {
    const memReported = selected.memoryUsedMb !== undefined && selected.memoryTotalMb !== undefined;
    const lastSeenMs = selected.lastHeartbeat ? Date.parse(selected.lastHeartbeat) : Number.NaN;
    const lastSeen = Number.isNaN(lastSeenMs) ? undefined : ageFromMs(lastSeenMs, Date.now());
    return (
      <Box flexDirection="column">
        <Text bold>Agent {selected.id}</Text>
        <Text>
          Site: <Text color="cyan">{selected.site}</Text>
        </Text>
        <Text>Scheduler: {selected.scheduler}</Text>
        <Text>
          Status: <Text color={statusColor(selected.status)}>{selected.status}</Text>
        </Text>
        {lastSeen ? <Text>Last seen: {lastSeen} ago</Text> : null}
        {selected.cpuPercent !== undefined && <Text>CPU: {Math.round(selected.cpuPercent)}%</Text>}
        {memReported && (
          <Text>
            Memory: {((selected.memoryUsedMb ?? 0) / 1024).toFixed(1)}/
            {((selected.memoryTotalMb ?? 0) / 1024).toFixed(1)} GiB
          </Text>
        )}
        {selected.queueDepth !== undefined && <Text>Queue: {selected.queueDepth}</Text>}
        {selected.diskUsedPercent !== undefined && (
          <Text>Disk: {Math.round(selected.diskUsedPercent)}%</Text>
        )}
        {(selected.gpus ?? []).map((g) => (
          <Text key={g.index}>
            GPU{g.index} {g.model}: {Math.round(g.utilPercent)}% {(g.memUsedMb / 1024).toFixed(1)}/
            {(g.memTotalMb / 1024).toFixed(1)} GiB
          </Text>
        ))}
      </Box>
    );
  }

  if (state.loading && state.agents.length === 0) {
    return <Text color="gray">Loading agents…</Text>;
  }
  if (state.error && agents.length === 0) {
    return <Text color="red">Error: {state.error}</Text>;
  }
  if (agents.length === 0) {
    return (
      <Text color="gray">
        {state.filter ? `No agents match "${state.filter}".` : "No agents registered."}
      </Text>
    );
  }

  const now = Date.now();
  const win = windowRows(agents, state.selectedIndex, viewportRows);
  return (
    <Box flexDirection="column">
      <Text color="gray">{summarizeStatuses(agents.map((a) => a.status))}</Text>
      <Text bold color="gray">
        {"  "}
        {padCell("AGENT ID", COLS.id)} {padCell("SITE", COLS.site)}{" "}
        {padCell("SCHEDULER", COLS.sched)} {padCell("STATUS", COLS.status)}{" "}
        {padCell("SEEN", COLS.seen)}
      </Text>
      <ErrorBanner error={state.error} />
      <ScrollHint count={win.hiddenAbove} direction="up" />
      {win.rows.map((agent, i) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={win.startIndex + i === state.selectedIndex}
          now={now}
        />
      ))}
      <ScrollHint count={win.hiddenBelow} direction="down" />
    </Box>
  );
}
