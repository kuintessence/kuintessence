import { describe, expect, test } from "bun:test";
import type { TuiAgent } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { AgentsPane } from "./agents-pane";

function detailState(agent: TuiAgent): TuiState {
  return { ...initialState("agents"), agents: [agent], view: "detail", detailId: agent.id };
}

describe("AgentsPane list", () => {
  test("shows a SEEN column with each agent's heartbeat age", async () => {
    const state: TuiState = {
      ...initialState("agents"),
      agents: [
        {
          id: "ag1",
          site: "north",
          scheduler: "slurm 23",
          status: "running",
          lastHeartbeat: "2020-01-01T00:00:00Z",
        },
        { id: "ag2", site: "south", scheduler: "pbs 2024", status: "running" },
      ],
    };
    const { lastFrame } = await render(<AgentsPane state={state} viewportRows={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SEEN");
    expect(frame).toMatch(/\d+d/); // ag1's years-old heartbeat in days
    expect(frame).toContain("—"); // ag2 never reported
  });
});

describe("AgentsPane detail", () => {
  test("surfaces live telemetry (CPU/mem/queue/disk/GPU) when present", async () => {
    const { lastFrame } = await render(
      <AgentsPane
        state={detailState({
          id: "ag-g",
          site: "north",
          scheduler: "slurm 23",
          status: "running",
          cpuPercent: 55,
          memoryUsedMb: 8192,
          memoryTotalMb: 16384,
          queueDepth: 4,
          diskUsedPercent: 73,
          gpus: [{ index: 0, model: "A100", utilPercent: 91, memUsedMb: 20000, memTotalMb: 40000 }],
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent ag-g");
    expect(frame).toContain("CPU");
    expect(frame).toContain("55%");
    expect(frame).toContain("Memory");
    expect(frame).toContain("8.0/16.0");
    expect(frame).toContain("Queue");
    expect(frame).toContain("4");
    expect(frame).toContain("Disk");
    expect(frame).toContain("73%");
    expect(frame).toContain("GPU0");
    expect(frame).toContain("91%");
    expect(frame).toContain("A100");
  });

  test("shows how long ago the agent last reported", async () => {
    const { lastFrame } = await render(
      <AgentsPane
        state={detailState({
          id: "ag-z",
          site: "s",
          scheduler: "slurm",
          status: "running",
          lastHeartbeat: "2020-01-01T00:00:00Z",
        })}
      />,
    );
    // years in the past → always rendered in whole days, regardless of "now"
    expect(lastFrame() ?? "").toMatch(/Last seen: \d+d ago/);
  });

  test("omits telemetry lines for an agent that hasn't reported", async () => {
    const { lastFrame } = await render(
      <AgentsPane
        state={detailState({ id: "ag-x", site: "s", scheduler: "pbs", status: "running" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent ag-x");
    expect(frame).not.toContain("CPU");
    expect(frame).not.toContain("GPU0");
  });
});
