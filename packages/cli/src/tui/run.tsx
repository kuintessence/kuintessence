import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { runInteractiveSsh } from "../commands/ssh";
import { type CliConfig, loadCliConfig } from "../lib/config";
import { App } from "./app";
import { type SelectBackendOptions, selectBackend } from "./backend/select";
import { Text, useApp, useInput } from "./opentui";
import type { PaneId } from "./store";

/** Options for {@link runTui}: backend selection (incl. local SQLite store
 *  controls) plus the optional startup pane and poll cadence. */
export type RunTuiOptions = SelectBackendOptions & { initialPane?: PaneId; pollMs?: number };

/** Raised when `kq tui` is launched without an interactive terminal (e.g. under
 *  a pipe or in CI). OpenTUI needs raw-mode stdin for keyboard navigation. */
export class NotATtyError extends Error {
  constructor() {
    super(
      "kq tui needs an interactive terminal (TTY). Run it directly in your shell, " +
        "not through a pipe or non-interactive session.",
    );
    this.name = "NotATtyError";
  }
}

async function createTuiRoot(onDestroy: () => void) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy });
  return { renderer, root: createRoot(renderer) };
}

function RendererSmoke() {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" && !key.ctrl && !key.meta) exit();
  });
  return <Text>OpenTUI renderer smoke</Text>;
}

/** Create a real OpenTUI renderer for packaged-binary release smoke tests. */
export async function runTuiRendererSmoke(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NotATtyError();
  }
  let resolveDestroyed: (() => void) | undefined;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const { root } = await createTuiRoot(() => resolveDestroyed?.());
  root.render(<RendererSmoke />);
  await destroyed;
}

/**
 * Resolve the backend and run the OpenTUI app. When the user opens an SSH shell
 * to an agent, the renderer is destroyed, the terminal is handed to the
 * interactive session, and a fresh renderer is created once it ends.
 */
export async function runTui(opts: RunTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NotATtyError();
  }
  const config: CliConfig = opts.config ?? loadCliConfig();
  const backend = await selectBackend({ ...opts, config });

  for (;;) {
    let sshAgentId: string | null = null;
    let resolveDestroyed: (() => void) | undefined;
    const destroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    const { renderer, root } = await createTuiRoot(() => resolveDestroyed?.());
    const onSsh = (agentId: string): void => {
      sshAgentId = agentId;
      renderer.destroy();
    };
    root.render(
      <App backend={backend} initialPane={opts.initialPane} pollMs={opts.pollMs} onSsh={onSsh} />,
    );
    await destroyed;

    if (sshAgentId === null) return; // normal quit
    await runEmbeddedSsh(config, sshAgentId);
    // Loop: re-render a fresh app after the session ends.
  }
}

async function runEmbeddedSsh(config: CliConfig, agentId: string): Promise<void> {
  process.stdout.write(`\nConnecting to ${agentId}…\n`);
  try {
    const result = await runInteractiveSsh(config, agentId);
    if (result.exitCode !== 0 && result.reason) {
      process.stdout.write(`ssh session ended: ${result.reason}\n`);
    }
  } catch (err) {
    process.stdout.write(`ssh failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
