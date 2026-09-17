import type { PlacementTrace } from "@kuintessence/shared/browser";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PlacementPipelineView } from "./PlacementPipelineView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

function buildTrace(overrides: Partial<PlacementTrace> = {}): PlacementTrace {
  return {
    generatedAt: "2026-05-01T00:00:00.000Z",
    preview: false,
    candidateCount: 3,
    stages: [
      {
        name: "compute-health",
        inputCount: 3,
        passed: [{ agentId: "good" }, { agentId: "okay" }, { agentId: "guest-x" }],
        rejected: [],
      },
      {
        name: "permission",
        inputCount: 3,
        passed: [{ agentId: "good" }, { agentId: "okay" }],
        rejected: [{ agent: { agentId: "guest-x" }, reason: "guest role cannot dispatch" }],
      },
      {
        name: "queue",
        inputCount: 2,
        passed: [{ agentId: "good" }, { agentId: "okay" }],
        rejected: [],
      },
      {
        name: "software",
        inputCount: 2,
        passed: [{ agentId: "good" }, { agentId: "okay" }],
        rejected: [],
      },
      {
        name: "billing",
        inputCount: 2,
        passed: [{ agentId: "good" }, { agentId: "okay" }],
        rejected: [],
      },
      {
        name: "load",
        inputCount: 2,
        passed: [{ agentId: "good" }],
        rejected: [{ agent: { agentId: "okay" }, reason: "cpu usage 99% above threshold" }],
      },
      { name: "urgency", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "install-rights", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      { name: "manual", inputCount: 1, passed: [{ agentId: "good" }], rejected: [] },
      {
        name: "auto",
        inputCount: 1,
        passed: [{ agentId: "good", siteName: "site-1", score: 88 }],
        rejected: [],
      },
    ],
    finalDecision: { agentId: "good", siteName: "site-1", score: 88 },
    ...overrides,
  };
}

describe("PlacementPipelineView", () => {
  test("renders the empty state when trace is null", () => {
    render(<PlacementPipelineView trace={null} />);
    expect(screen.getByTestId("placement-empty")).toBeTruthy();
  });

  test("renders all canonical stages in order", () => {
    render(<PlacementPipelineView trace={buildTrace()} />);
    const list = screen.getByTestId("placement-stages");
    const stageNames = within(list)
      .getAllByText(
        /compute-health|permission|queue|software|billing|load|urgency|install-rights|manual|auto/,
      )
      .map((el) => el.textContent);
    for (const name of [
      "compute-health",
      "permission",
      "queue",
      "software",
      "billing",
      "load",
      "urgency",
      "install-rights",
      "manual",
      "auto",
    ]) {
      expect(stageNames).toContain(name);
    }
  });

  test("highlights the final picked agent in the banner with its score", () => {
    render(<PlacementPipelineView trace={buildTrace()} />);
    const banner = screen.getByTestId("placement-final-decision");
    expect(banner.textContent).toContain("good");
    expect(banner.textContent).toContain("88");
  });

  test("shows the no-decision banner when finalDecision is null", () => {
    render(
      <PlacementPipelineView
        trace={buildTrace({
          finalDecision: null,
          stages: buildTrace().stages.map((s) =>
            s.name === "permission"
              ? {
                  ...s,
                  passed: [],
                  rejected: [
                    ...s.rejected,
                    { agent: { agentId: "good" }, reason: "guest" },
                    { agent: { agentId: "okay" }, reason: "guest" },
                  ],
                }
              : { ...s, inputCount: 0, passed: [], rejected: [] },
          ),
        })}
      />,
    );
    expect(screen.getByTestId("placement-no-decision")).toBeTruthy();
  });

  test("auto-expands stages with rejections and lists each rejected agent + reason", () => {
    render(<PlacementPipelineView trace={buildTrace()} />);
    expect(screen.getByTestId("placement-stage-toggle-permission").className).toContain(
      "flex-wrap",
    );
    const permRejected = screen.getByTestId("placement-rejected-permission");
    expect(permRejected.textContent).toContain("guest-x");
    expect(permRejected.textContent).toContain("guest role cannot dispatch");

    const loadRejected = screen.getByTestId("placement-rejected-load");
    expect(loadRejected.textContent).toContain("okay");
    expect(loadRejected.textContent).toContain("99%");
  });

  test("a stage row toggles open/closed when its header is clicked", () => {
    render(<PlacementPipelineView trace={buildTrace()} />);
    const toggle = screen.getByTestId("placement-stage-toggle-permission");
    // Initially expanded because there are rejections.
    expect(screen.queryByTestId("placement-rejected-permission")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("placement-rejected-permission")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("placement-rejected-permission")).toBeTruthy();
  });

  test("expanded pass-only stages show the passed candidates instead of an empty body", () => {
    render(<PlacementPipelineView trace={buildTrace()} />);
    fireEvent.click(screen.getByTestId("placement-stage-toggle-queue"));

    const passed = screen.getByTestId("placement-passed-queue");
    expect(passed.textContent).toContain("good");
    expect(passed.textContent).toContain("okay");
  });

  test("clicking the final-decision banner invokes onAgentPick", () => {
    const onPick = vi.fn();
    render(<PlacementPipelineView trace={buildTrace()} onAgentPick={onPick} />);
    fireEvent.click(screen.getByTestId("placement-final-decision"));
    expect(onPick).toHaveBeenCalledWith("good");
  });

  test("clicking a rejected agent row invokes onAgentPick with that id", () => {
    const onPick = vi.fn();
    render(<PlacementPipelineView trace={buildTrace()} onAgentPick={onPick} />);
    const row = screen.getByTestId("placement-rejected-row-guest-x");
    const button = within(row).getByText("guest-x");
    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledWith("guest-x");
  });
});
