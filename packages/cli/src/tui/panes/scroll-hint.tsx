import { Text } from "../opentui";

/** A one-line "N more above/below" indicator for windowed (virtualized) lists.
 *  Renders nothing when no rows are hidden in that direction. */
export function ScrollHint({ count, direction }: { count: number; direction: "up" | "down" }) {
  if (count <= 0) return null;
  const arrow = direction === "up" ? "↑" : "↓";
  return (
    <Text color="gray">
      {"  "}
      {arrow} {count} more
    </Text>
  );
}

/** A non-fatal error banner shown above a list that still has last-good rows —
 *  so a transient poll failure doesn't wipe the view. Renders nothing if no
 *  error. */
export function ErrorBanner({ error }: { error: string | undefined }) {
  if (!error) return null;
  return (
    <Text color="red">
      {"  "}⚠ {error}
    </Text>
  );
}
