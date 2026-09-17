import { describe, expect, test } from "bun:test";
import type { TuiJob } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { JobsPane } from "./jobs-pane";

const jobs: TuiJob[] = [
  { id: "j1", name: "wrf-ens", status: "running", location: "compute", submittedAt: "t" },
];

function detailState(over: Partial<TuiState["jobDetail"]>): TuiState {
  return {
    ...initialState(),
    jobs,
    view: "detail",
    jobDetail: { loading: false, ...over },
  };
}

describe("JobsPane virtualization", () => {
  const many: TuiJob[] = Array.from({ length: 500 }, (_, i) => ({
    id: `j${i}`,
    name: `job-${i}`,
    status: "running",
    location: "compute",
  }));

  test("renders only a window of rows with scroll hints", async () => {
    const state: TuiState = { ...initialState(), jobs: many, selectedIndex: 250 };
    const { lastFrame } = await render(<JobsPane state={state} mode="remote" viewportRows={10} />);
    const frame = lastFrame() ?? "";
    // selected row visible, far-off rows not rendered
    expect(frame).toContain("job-250");
    expect(frame).not.toContain("job-0 ");
    expect(frame).not.toContain("job-499");
    // both scroll hints present mid-list
    expect(frame).toMatch(/↑ \d+ more/);
    expect(frame).toMatch(/↓ \d+ more/);
  });

  test("no hints when the list fits the viewport", async () => {
    const state: TuiState = { ...initialState(), jobs: many.slice(0, 5) };
    const { lastFrame } = await render(<JobsPane state={state} mode="remote" viewportRows={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("more");
  });
});

describe("JobsPane detail", () => {
  test("renders the row plus enriched fields once fetched", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: {
            id: "j1",
            name: "wrf-ens",
            status: "completed",
            schedulerJobId: "12345",
            startedAt: "2026-05-30T11:00:00Z",
            completedAt: "2026-05-30T12:00:00Z",
            exitCode: 0,
          },
        })}
        mode="remote"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Job j1");
    expect(frame).toContain("Scheduler ID: 12345");
    expect(frame).toContain("Exit code: 0");
    // start → completed span renders as elapsed runtime
    expect(frame).toContain("Elapsed: 1h");
    // enriched status overrides the running row status
    expect(frame).toContain("completed");
  });

  test("shows the allocated node and start time when the scheduler reports them", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: {
            id: "j1",
            name: "wrf-ens",
            status: "running",
            schedulerJobId: "12345",
            node: "node[001-004]",
            startedAt: "2023-11-14T22:13:20.000Z",
          },
        })}
        mode="local"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Node: node[001-004]");
    expect(frame).toContain("Started: 2023-11-14T22:13:20.000Z");
  });

  test("shows the queue wait from submit to start", async () => {
    const queuedJobs: TuiJob[] = [
      {
        id: "j1",
        name: "wrf-ens",
        status: "running",
        location: "compute",
        submittedAt: "2026-05-30T11:00:00Z",
      },
    ];
    const state: TuiState = {
      ...initialState(),
      jobs: queuedJobs,
      view: "detail",
      jobDetail: {
        loading: false,
        data: { id: "j1", name: "wrf-ens", status: "running", startedAt: "2026-05-30T11:05:00Z" },
      },
    };
    const { lastFrame } = await render(<JobsPane state={state} mode="local" />);
    expect(lastFrame() ?? "").toContain("Queued: 5m");
  });

  test("shows the submit-time resource request when present", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: {
            id: "j1",
            name: "wrf-ens",
            status: "running",
            command: "./run.sh --np 16",
            cpus: 16,
            memoryMb: 32768,
          },
        })}
        mode="local"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Requested: 16 CPU");
    expect(frame).toContain("32.0 GiB");
    expect(frame).toContain("Command: ./run.sh --np 16");
  });

  test("includes GPU count in the resource request when requested", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: { id: "j1", name: "g", status: "running", cpus: 8, memoryMb: 16384, gpus: 4 },
        })}
        mode="local"
      />,
    );
    expect(lastFrame() ?? "").toContain("8 CPU · 16.0 GiB · 4 GPU");
  });

  test("shows the wall-time limit when the submit spec set one", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: { id: "j1", name: "g", status: "running", wallTimeSec: 5400 },
        })}
        mode="local"
      />,
    );
    expect(lastFrame() ?? "").toContain("Time limit: 1h30m");
  });

  test("shows the scheduler pending reason when present", async () => {
    const { lastFrame } = await render(
      <JobsPane
        state={detailState({
          data: { id: "j1", name: "wrf-ens", status: "queued", reason: "Resources" },
        })}
        mode="local"
      />,
    );
    expect(lastFrame() ?? "").toContain("Reason: Resources");
  });

  test("shows a refreshing hint while the detail loads", async () => {
    const { lastFrame } = await render(
      <JobsPane state={detailState({ loading: true })} mode="local" />,
    );
    expect(lastFrame() ?? "").toContain("refreshing…");
  });

  test("surfaces a detail error without hiding the row", async () => {
    const { lastFrame } = await render(
      <JobsPane state={detailState({ error: "not found" })} mode="remote" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Job j1");
    expect(frame).toContain("not found");
  });
});

describe("JobsPane multi-select marks", () => {
  const rows: TuiJob[] = [
    { id: "a", name: "j1", status: "running", location: "c" },
    { id: "b", name: "j2", status: "running", location: "c" },
    { id: "c", name: "j3", status: "queued", location: "c" },
  ];

  test("marks the chosen rows and shows a marked count in the summary", async () => {
    const state: TuiState = { ...initialState(), jobs: rows, marked: new Set(["a", "c"]) };
    const { lastFrame } = await render(<JobsPane state={state} mode="local" viewportRows={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◉"); // a mark glyph is rendered
    expect(frame).toContain("2 marked"); // summary reflects the count
  });

  test("no mark glyph or marked count when nothing is marked", async () => {
    const state: TuiState = { ...initialState(), jobs: rows };
    const { lastFrame } = await render(<JobsPane state={state} mode="local" viewportRows={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("◉");
    expect(frame).not.toContain("marked");
  });
});

describe("JobsPane status summary", () => {
  test("shows a total + per-status breakdown above the list", async () => {
    const mixed: TuiJob[] = [
      { id: "a", name: "j1", status: "running", location: "c" },
      { id: "b", name: "j2", status: "running", location: "c" },
      { id: "c", name: "j3", status: "failed", location: "c" },
    ];
    const state: TuiState = { ...initialState(), jobs: mixed };
    const { lastFrame } = await render(<JobsPane state={state} mode="local" viewportRows={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("3 total · 2 running · 1 failed");
  });
});
