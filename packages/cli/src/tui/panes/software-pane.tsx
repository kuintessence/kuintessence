import type { TuiSoftware } from "../backend/types";
import { padCell } from "../format";
import { Box, Text } from "../opentui";
import { pinnedItem, type TuiState, visibleSoftware } from "../store";
import { DEFAULT_VIEWPORT_ROWS, windowRows } from "../viewport";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

const COLS = { source: 10, name: 28, versions: 24, lifecycle: 12 } as const;

function lifecycleColor(lifecycle: string): string {
  if (lifecycle === "published" || lifecycle === "installed") return "green";
  if (lifecycle === "removed" || lifecycle === "deprecated") return "red";
  return "gray";
}

function SoftwareRow({ item, selected }: { item: TuiSoftware; selected: boolean }) {
  return (
    <Text inverse={selected}>
      {"  "}
      {padCell(item.source, COLS.source)} {padCell(item.name, COLS.name)}{" "}
      {padCell(item.versions.join(", ") || "-", COLS.versions)}{" "}
      <Text color={lifecycleColor(item.lifecycle)}>{padCell(item.lifecycle, COLS.lifecycle)}</Text>
    </Text>
  );
}

/** Pure presentational software-repository pane (Server-only). */
export function SoftwarePane({
  state,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
}: {
  state: TuiState;
  viewportRows?: number;
}) {
  const items = visibleSoftware(state);
  const selected = pinnedItem(items, state.detailId, state.selectedIndex);

  if (state.view === "detail" && selected) {
    return (
      <Box flexDirection="column">
        <Text bold>{selected.id}</Text>
        <Text>
          Source: <Text color="cyan">{selected.source}</Text>
        </Text>
        <Text>
          Versions: <Text color="cyan">{selected.versions.join(", ") || "-"}</Text>
        </Text>
        <Text>
          Lifecycle: <Text color={lifecycleColor(selected.lifecycle)}>{selected.lifecycle}</Text>
        </Text>
        {selected.locked === undefined ? null : (
          <Text>Locked: {selected.locked ? "yes" : "no"}</Text>
        )}
        {selected.spec ? <Text>Spec: {selected.spec}</Text> : null}
      </Box>
    );
  }

  if (state.loading && state.software.length === 0) {
    return <Text color="gray">Loading software…</Text>;
  }
  if (state.error && items.length === 0) {
    return <Text color="red">Error: {state.error}</Text>;
  }
  if (items.length === 0) {
    return (
      <Text color="gray">
        {state.filter ? `No software matches "${state.filter}".` : "No software found."}
      </Text>
    );
  }

  const win = windowRows(items, state.selectedIndex, viewportRows);
  return (
    <Box flexDirection="column">
      <Text color="gray">
        {state.softwarePage.totalCount} packages · page {state.softwarePage.page}/
        {state.softwarePage.totalPages}
      </Text>
      <Text bold color="gray">
        {"  "}
        {padCell("SOURCE", COLS.source)} {padCell("NAME", COLS.name)}{" "}
        {padCell("VERSIONS", COLS.versions)} {padCell("LIFECYCLE", COLS.lifecycle)}
      </Text>
      <ErrorBanner error={state.error} />
      <ScrollHint count={win.hiddenAbove} direction="up" />
      {win.rows.map((item, i) => (
        <SoftwareRow
          key={item.id}
          item={item}
          selected={win.startIndex + i === state.selectedIndex}
        />
      ))}
      <ScrollHint count={win.hiddenBelow} direction="down" />
    </Box>
  );
}
