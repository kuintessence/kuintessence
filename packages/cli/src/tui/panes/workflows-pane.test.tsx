import { describe, expect, test } from "bun:test";
import type { TuiWorkflowRun } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { WorkflowsPane } from "./workflows-pane";

const runs: TuiWorkflowRun[] = [{ id: "w1", name: "pipeline", status: "running" }];

function detailState(over: Partial<TuiState["wfDetail"]>): TuiState {
  return {
    ...initialState("workflows"),
    workflows: runs,
    view: "detail",
    wfDetail: { loading: false, ...over },
  };
}

describe("WorkflowsPane detail", () => {
  test("renders the step tree from fetched detail", async () => {
    const { lastFrame } = await render(
      <WorkflowsPane
        state={detailState({
          data: {
            id: "w1",
            name: "pipeline",
            status: "running",
            steps: [
              { id: "build", status: "completed", info: '{"artifact":"a.tar"}' },
              { id: "run", status: "running" },
            ],
          },
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Steps:");
    expect(frame).toContain("build");
    expect(frame).toContain("[completed]");
    expect(frame).toContain("a.tar");
    expect(frame).toContain("run");
    // status glyphs flag each step (✓ completed, ● running) for fast scanning
    expect(frame).toContain("✓");
    expect(frame).toContain("●");
    // run-level progress summary over the step statuses
    expect(frame).toContain("2 total · 1 running · 1 completed");
  });

  test("summarizes step progress, treating blank statuses as pending", async () => {
    const { lastFrame } = await render(
      <WorkflowsPane
        state={detailState({
          data: {
            id: "w1",
            name: "pipeline",
            status: "running",
            steps: [
              { id: "a", status: "completed" },
              { id: "b", status: "" },
              { id: "c", status: "" },
            ],
          },
        })}
      />,
    );
    expect(lastFrame() ?? "").toContain("3 total · 1 completed · 2 pending");
  });

  test("shows a loading line while the detail fetch is in flight", async () => {
    const { lastFrame } = await render(<WorkflowsPane state={detailState({ loading: true })} />);
    expect(lastFrame() ?? "").toContain("Loading steps…");
  });

  test("surfaces a detail-fetch error", async () => {
    const { lastFrame } = await render(
      <WorkflowsPane state={detailState({ error: "run not found" })} />,
    );
    expect(lastFrame() ?? "").toContain("run not found");
  });
});
