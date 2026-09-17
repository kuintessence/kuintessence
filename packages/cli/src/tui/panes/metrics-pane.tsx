import type { TuiAgent } from "../backend/types";
import { asciiBar, padCell, seenLabel, sparkline, statusColor, statusGlyph } from "../format";
import { Box, Text } from "../opentui";
import { type TuiState, visibleAgents } from "../store";
import { DEFAULT_VIEWPORT_ROWS, windowByHeight } from "../viewport";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

/** Rendered row count for one agent: name + CPU + MEM + QUE (4) + a 1-row
 *  marginBottom gap, plus an optional DSK line and one row per GPU. Drives the
 *  Metrics pane's viewport packing so GPU/disk nodes — several rows taller than
 *  a bare one — don't overflow the terminal. */
export function agentRowHeight(agent: TuiAgent): number {
  const disk = agent.diskUsedPercent !== undefined ? 1 : 0;
  const gpus = agent.gpus?.length ?? 0;
  return 5 + disk + gpus;
}

/** Fleet-wide capacity at a glance for the Metrics header: node count, total
 *  queue depth (how backed-up the whole system is), and total GPUs (omitted
 *  when zero). Useful in a multi-cluster (remote) deployment. */
export function fleetSummary(agents: TuiAgent[]): string {
  const queue = agents.reduce((sum, a) => sum + (a.queueDepth ?? 0), 0);
  const gpus = agents.reduce((sum, a) => sum + (a.gpus?.length ?? 0), 0);
  const nodes = `${agents.length} ${agents.length === 1 ? "node" : "nodes"}`;
  return gpus > 0 ? `${nodes} · queue ${queue} · gpus ${gpus}` : `${nodes} · queue ${queue}`;
}

const BAR_W = 16;
const NAME_W = 20;

function pct(value: number | undefined): string {
  return value === undefined ? "  n/a" : `${String(Math.round(value)).padStart(3, " ")}%`;
}

function memUsage(a: TuiAgent): { ratio: number; label: string } {
  if (a.memoryUsedMb === undefined || !a.memoryTotalMb) {
    return { ratio: 0, label: "n/a" };
  }
  const usedGb = (a.memoryUsedMb / 1024).toFixed(1);
  const totalGb = (a.memoryTotalMb / 1024).toFixed(1);
  return { ratio: (a.memoryUsedMb / a.memoryTotalMb) * 100, label: `${usedGb}/${totalGb}G` };
}

function gpuMemLabel(usedMb: number, totalMb: number): string {
  return `${(usedMb / 1024).toFixed(1)}/${(totalMb / 1024).toFixed(1)}G`;
}

function AgentMetrics({
  agent,
  selected,
  now,
  cpuHistory,
  memHistory,
  queueHistory,
}: {
  agent: TuiAgent;
  selected: boolean;
  now: number;
  cpuHistory?: number[];
  memHistory?: number[];
  queueHistory?: number[];
}) {
  const mem = memUsage(agent);
  const queueMax = agent.maxConcurrentJobs ?? 100;
  const seen = agent.lastHeartbeat ? seenLabel(agent.lastHeartbeat, now) : undefined;
  // A short trend needs ≥2 samples to be meaningful.
  const cpuTrend = cpuHistory && cpuHistory.length >= 2 ? sparkline(cpuHistory, 100) : "";
  const memTrend = memHistory && memHistory.length >= 2 ? sparkline(memHistory, 100) : "";
  const queueTrend =
    queueHistory && queueHistory.length >= 2 ? sparkline(queueHistory, queueMax) : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text inverse={selected}>
        <Text color={statusColor(agent.status)}>{statusGlyph(agent.status)} </Text>
        {padCell(`${agent.id} (${agent.site})`, NAME_W)}
        {seen ? <Text color="gray"> seen {seen}</Text> : null}
      </Text>
      <Text>
        {"  CPU  "}
        <Text color="cyan">{asciiBar(agent.cpuPercent ?? 0, 100, BAR_W)}</Text>{" "}
        {pct(agent.cpuPercent)}
        {cpuTrend ? <Text color="gray"> {cpuTrend}</Text> : null}
      </Text>
      <Text>
        {"  MEM  "}
        <Text color="green">{asciiBar(mem.ratio, 100, BAR_W)}</Text> {mem.label}
        {memTrend ? <Text color="gray"> {memTrend}</Text> : null}
      </Text>
      <Text>
        {"  QUE  "}
        <Text color="yellow">{asciiBar(agent.queueDepth ?? 0, queueMax, BAR_W)}</Text>{" "}
        {agent.queueDepth ?? 0}/{queueMax}
        {queueTrend ? <Text color="gray"> {queueTrend}</Text> : null}
      </Text>
      {agent.diskUsedPercent !== undefined && (
        <Text>
          {"  DSK  "}
          <Text color="blue">{asciiBar(agent.diskUsedPercent, 100, BAR_W)}</Text>{" "}
          {pct(agent.diskUsedPercent)}
        </Text>
      )}
      {(agent.gpus ?? []).map((g) => (
        <Text key={g.index}>
          {`  GPU${g.index} `}
          <Text color="magenta">{asciiBar(g.utilPercent, 100, BAR_W)}</Text> {pct(g.utilPercent)}{" "}
          {gpuMemLabel(g.memUsedMb, g.memTotalMb)} {g.model}
        </Text>
      ))}
    </Box>
  );
}

/** Per-agent resource dashboard (ASCII bars). Reuses the agents data loaded for
 *  the Agents pane — CPU%, memory usage, and queue depth from the Server agent row. */
export function MetricsPane({
  state,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
  cpuHistory,
  memHistory,
  queueHistory,
}: {
  state: TuiState;
  viewportRows?: number;
  /** Per-agent CPU sample history (by agent id) for the trend sparkline. */
  cpuHistory?: Map<string, number[]>;
  /** Per-agent memory-usage% sample history (by agent id) for the trend sparkline. */
  memHistory?: Map<string, number[]>;
  /** Per-agent queue-depth sample history (by agent id) for the trend sparkline. */
  queueHistory?: Map<string, number[]>;
}) {
  const agents = visibleAgents(state);

  if (state.loading && state.agents.length === 0) {
    return <Text color="gray">Loading agent metrics…</Text>;
  }
  if (state.error && agents.length === 0) {
    return <Text color="red">Error: {state.error}</Text>;
  }
  if (agents.length === 0) {
    return (
      <Text color="gray">
        {state.filter ? `No agents match "${state.filter}".` : "No agents reporting metrics."}
      </Text>
    );
  }

  const now = Date.now();
  const win = windowByHeight(agents, state.selectedIndex, agentRowHeight, viewportRows);
  return (
    <Box flexDirection="column">
      <Text color="gray">{fleetSummary(agents)}</Text>
      <ErrorBanner error={state.error} />
      <ScrollHint count={win.hiddenAbove} direction="up" />
      {win.rows.map((agent, i) => (
        <AgentMetrics
          key={agent.id}
          agent={agent}
          selected={win.startIndex + i === state.selectedIndex}
          now={now}
          cpuHistory={cpuHistory?.get(agent.id)}
          memHistory={memHistory?.get(agent.id)}
          queueHistory={queueHistory?.get(agent.id)}
        />
      ))}
      <ScrollHint count={win.hiddenBelow} direction="down" />
    </Box>
  );
}
