// OpenTUI runtime smoke. The headless render/input path is asserted in
// spike.test.tsx. For a
// real TTY check (raw-mode keyboard, colours, layout in your terminal), run:
//     bun run packages/cli/src/tui/spike.tsx
// and press k/↑ to increment, q to quit.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState } from "react";
import { Box, Text, useApp, useInput } from "./opentui";

export function SpikeApp() {
  const [count, setCount] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q") exit();
    if (input === "k" || key.upArrow) setCount((c) => c + 1);
    if (input === "j" || key.downArrow) setCount((c) => Math.max(0, c - 1));
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="green">OpenTUI × Bun spike — TUI feasibility</Text>
      <Text>
        count: <Text color="cyan">{count}</Text> · press k/↑ inc · j/↓ dec · q quit
      </Text>
    </Box>
  );
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<SpikeApp />);
}
