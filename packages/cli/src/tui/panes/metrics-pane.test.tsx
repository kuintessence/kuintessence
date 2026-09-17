import { describe, expect, test } from "bun:test";
import type { TuiAgent } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { agentRowHeight, fleetSummary, MetricsPane } from "./metrics-pane";

function withAgents(agents: TuiAgent[], over: Partial<TuiState> = {}): TuiState {
  return { ...initialState("metrics"), agents, ...over };
}

describe("fleetSummary", () => {
  test("totals nodes, queue depth, and GPUs across agents", async () => {
    const gpu = { index: 0, model: "A100", utilPercent: 0, memUsedMb: 0, memTotalMb: 0 };
    const agents: TuiAgent[] = [
      {
        id: "a",
        site: "n",
        scheduler: "slurm",
        status: "running",
        queueDepth: 5,
        gpus: [gpu, gpu],
      },
      { id: "b", site: "s", scheduler: "slurm", status: "running", queueDepth: 3, gpus: [gpu] },
      { id: "c", site: "e", scheduler: "slurm", status: "running" },
    ];
    expect(fleetSummary(agents)).toBe("3 nodes · queue 8 · gpus 3");
  });

  test("singular node label and omits the gpu term when there are none", async () => {
    const agents: TuiAgent[] = [
      { id: "a", site: "n", scheduler: "slurm", status: "running", queueDepth: 2 },
    ];
    expect(fleetSummary(agents)).toBe("1 node · queue 2");
  });
});

describe("agentRowHeight", () => {
  const base: TuiAgent = { id: "n", site: "s", scheduler: "slurm", status: "running" };

  test("a bare node is the base height (name + CPU/MEM/QUE + gap)", async () => {
    expect(agentRowHeight(base)).toBe(5);
  });

  test("a disk line adds one row", async () => {
    expect(agentRowHeight({ ...base, diskUsedPercent: 40 })).toBe(6);
  });

  test("each GPU adds a row; disk + 2 GPUs is the base plus three", async () => {
    const gpus = [
      { index: 0, model: "A100", utilPercent: 10, memUsedMb: 1, memTotalMb: 2 },
      { index: 1, model: "A100", utilPercent: 20, memUsedMb: 1, memTotalMb: 2 },
    ];
    expect(agentRowHeight({ ...base, diskUsedPercent: 40, gpus })).toBe(8);
  });
});

describe("MetricsPane", () => {
  test("renders CPU/MEM/QUE bars per agent from resource fields", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          {
            id: "ag-n",
            site: "north",
            scheduler: "slurm 23",
            status: "running",
            cpuPercent: 50,
            memoryUsedMb: 4096,
            memoryTotalMb: 8192,
            queueDepth: 3,
            maxConcurrentJobs: 10,
          },
        ])}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ag-n (north)");
    expect(frame).toContain("CPU");
    expect(frame).toContain("50%");
    expect(frame).toContain("MEM");
    expect(frame).toContain("4.0/8.0G");
    expect(frame).toContain("QUE");
    expect(frame).toContain("3/10");
    expect(frame).toContain("█"); // a filled bar segment rendered
  });

  test("flags heartbeat freshness in the agent header so stale bars are obvious", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          {
            id: "ag-n",
            site: "north",
            scheduler: "slurm 23",
            status: "running",
            cpuPercent: 50,
            lastHeartbeat: "2020-01-01T00:00:00Z",
          },
        ])}
      />,
    );
    // years-old heartbeat → day-grained "seen" marker on the header line
    expect(lastFrame() ?? "").toMatch(/seen \d+d/);
  });

  test("renders a CPU trend sparkline from supplied history", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          { id: "ag-n", site: "north", scheduler: "slurm 23", status: "running", cpuPercent: 80 },
        ])}
        cpuHistory={new Map([["ag-n", [0, 50, 100]]])}
      />,
    );
    expect(lastFrame() ?? "").toContain("▁▅█");
  });

  test("renders a queue-depth trend sparkline from supplied history", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          {
            id: "ag-n",
            site: "north",
            scheduler: "slurm 23",
            status: "running",
            queueDepth: 8,
            maxConcurrentJobs: 10,
          },
        ])}
        queueHistory={new Map([["ag-n", [0, 5, 10]]])}
      />,
    );
    // 0/10, 5/10, 10/10 → ▁▅█ on the QUE line
    expect(lastFrame() ?? "").toContain("▁▅█");
  });

  test("renders a memory trend sparkline from supplied history", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          {
            id: "ag-n",
            site: "north",
            scheduler: "slurm 23",
            status: "running",
            memoryUsedMb: 8192,
            memoryTotalMb: 16384,
          },
        ])}
        memHistory={new Map([["ag-n", [0, 50, 100]]])}
      />,
    );
    expect(lastFrame() ?? "").toContain("▁▅█");
  });

  test("shows n/a when an agent hasn't reported resources", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([{ id: "ag-x", site: "s", scheduler: "pbs", status: "running" }])}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("n/a");
  });

  test("renders a DSK bar and one row per GPU when telemetry is present", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          {
            id: "ag-g",
            site: "gpu-site",
            scheduler: "slurm 23",
            status: "running",
            cpuPercent: 40,
            diskUsedPercent: 72,
            gpus: [
              { index: 0, model: "A100", utilPercent: 87, memUsedMb: 12000, memTotalMb: 40000 },
              { index: 1, model: "A100", utilPercent: 12, memUsedMb: 500, memTotalMb: 40000 },
            ],
          },
        ])}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("DSK");
    expect(frame).toContain("72%");
    expect(frame).toContain("GPU0");
    expect(frame).toContain("87%");
    expect(frame).toContain("GPU1");
    expect(frame).toContain("12%");
    expect(frame).toContain("A100");
  });

  test("omits DSK/GPU rows when an agent reports no GPU/disk telemetry", async () => {
    const { lastFrame } = await render(
      <MetricsPane
        state={withAgents([
          { id: "ag-c", site: "s", scheduler: "slurm", status: "running", cpuPercent: 5 },
        ])}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("GPU0");
    expect(frame).not.toContain("DSK");
  });

  test("virtualizes to a window of agents with scroll hints", async () => {
    const many: TuiAgent[] = Array.from({ length: 30 }, (_, i) => ({
      id: `ag-${i}`,
      site: "s",
      scheduler: "slurm",
      status: "running",
      cpuPercent: 10,
    }));
    const { lastFrame } = await render(
      <MetricsPane state={withAgents(many, { selectedIndex: 0 })} viewportRows={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ag-0 (s)");
    expect(frame).not.toContain("ag-29 (s)");
    expect(frame).toMatch(/↓ \d+ more/);
  });

  test("is a dashboard with no separate detail view (renders bars even in detail view)", async () => {
    const agent: TuiAgent = {
      id: "ag-n",
      site: "north",
      scheduler: "slurm 23",
      status: "running",
      cpuPercent: 50,
    };
    const { lastFrame } = await render(
      <MetricsPane state={withAgents([agent], { view: "detail", detailId: "ag-n" })} />,
    );
    // Same dashboard regardless of view → enter has nothing to "open" here.
    expect(lastFrame() ?? "").toContain("CPU");
  });

  test("empty + filtered-empty notices", async () => {
    expect((await render(<MetricsPane state={withAgents([])} />)).lastFrame() ?? "").toContain(
      "No agents reporting metrics.",
    );
    const filtered = (
      await render(
        <MetricsPane
          state={withAgents([{ id: "ag", site: "s", scheduler: "x", status: "running" }], {
            filter: "zzz",
          })}
        />,
      )
    ).lastFrame();
    expect(filtered ?? "").toContain('No agents match "zzz".');
  });
});
