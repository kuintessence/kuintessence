import { describe, expect, test } from "bun:test";
import { reconcileStaleAgentHeartbeats } from "./agent-heartbeat-sweeper";

describe("reconcileStaleAgentHeartbeats", () => {
  test("awaits the initial reconciliation before bootstrap can continue", async () => {
    let release: (() => void) | undefined;
    let completed = false;
    const pending = new Promise<string[]>((resolve) => {
      release = () => resolve(["stale-agent"]);
    });
    const logs: Array<{ agentIds: string[]; timeoutSec: number }> = [];

    const startup = reconcileStaleAgentHeartbeats(
      { sweepStaleHeartbeats: async () => await pending },
      90,
      { warn: (context) => logs.push(context) },
    ).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(logs).toEqual([]);

    release?.();
    await startup;
    expect(completed).toBe(true);
    expect(logs).toEqual([{ agentIds: ["stale-agent"], timeoutSec: 90 }]);
  });
});
