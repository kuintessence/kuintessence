import type { TuiJob } from "../backend/types";
import { grepLines } from "../format";
import { Box, Text } from "../opentui";
import type { TuiState } from "../store";

/** Default visible-line budget when no terminal-derived height is supplied —
 *  matches a typical 24-row terminal's log area. */
const DEFAULT_LOG_LINES = 20;

/** Renders a window of the fetched stdout/stderr for the selected job. The
 *  window shows up to `viewportRows` lines and is offset up from the bottom by
 *  `state.logs.scroll` (0 = pinned to the tail), so the user can scroll back
 *  through the fetched buffer instead of only ever seeing the last lines. */
export function LogsPane({
  state,
  job,
  viewportRows = DEFAULT_LOG_LINES,
}: {
  state: TuiState;
  job: TuiJob | undefined;
  viewportRows?: number;
}) {
  const { loading, error, text, following, scroll, search } = state.logs;
  const title = job ? `Logs — ${job.name} (${job.id})` : "Logs";

  if (loading && !text) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text color="gray">Loading logs…</Text>
      </Box>
    );
  }
  if (error) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  const allLines = text.replace(/\n$/, "").split("\n");
  const lines = grepLines(allLines, search);
  const total = lines.length;
  const height = Math.max(1, viewportRows);
  const offset = Math.max(0, Math.min(scroll, Math.max(0, total - height)));
  const end = total - offset;
  const start = Math.max(0, end - height);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;
  const noMatch = search !== "" && total === 0 && text.trim() !== "";

  return (
    <Box flexDirection="column">
      <Text bold>
        {title}
        {following ? <Text color="green"> ●LIVE</Text> : null}
        {offset > 0 ? <Text color="yellow"> ⇅scroll</Text> : null}
        {search ? (
          <Text color="cyan">
            {" "}
            ⌕"{search}" ({total}/{allLines.length})
          </Text>
        ) : null}
        {loading ? <Text color="gray"> (refreshing…)</Text> : null}
      </Text>
      {hiddenAbove > 0 ? <Text color="gray">… {hiddenAbove} earlier lines</Text> : null}
      {text.trim() === "" ? (
        <Text color="gray">(no output yet)</Text>
      ) : noMatch ? (
        <Text color="gray">(no lines match "{search}")</Text>
      ) : (
        <Text>{visible.join("\n")}</Text>
      )}
      {hiddenBelow > 0 ? <Text color="gray">↓ {hiddenBelow} newer lines</Text> : null}
    </Box>
  );
}
