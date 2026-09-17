import { describe, expect, test } from "bun:test";
import type {
  TuiAgent,
  TuiBackendCapabilities,
  TuiJob,
  TuiSoftware,
  TuiWorkflowRun,
} from "./backend/types";
import {
  activeLength,
  initialState,
  nextEnabledPane,
  paneAtPosition,
  pinnedItem,
  reducer,
  resolveInitialPane,
  visibleAgents,
  visibleJobs,
  visibleWorkflows,
} from "./store";

function job(id: string): TuiJob {
  return { id, name: `job-${id}`, status: "running", location: "compute" };
}

const threeJobs = [job("1"), job("2"), job("3")];
const workflows: TuiWorkflowRun[] = [
  { id: "w1", name: "pipeline", status: "running" },
  { id: "w2", name: "sweep", status: "completed" },
];
const agents: TuiAgent[] = [{ id: "ag1", site: "north", scheduler: "slurm 23", status: "running" }];
const software: TuiSoftware[] = [
  {
    id: "public/openmpi",
    name: "openmpi",
    source: "spack",
    versions: ["4.1.5"],
    lifecycle: "installed",
    spec: "openmpi@4.1.5",
  },
  {
    id: "org/cuda",
    name: "cuda",
    source: "vendor",
    versions: ["12.3"],
    lifecycle: "published",
    locked: true,
    spec: "cuda@12.3",
  },
];

describe("reducer — jobs lifecycle", () => {
  test("loading sets loading and clears error", () => {
    const s = reducer({ ...initialState(), error: "old" }, { type: "loading" });
    expect(s.loading).toBe(true);
    expect(s.error).toBeUndefined();
  });

  test("jobsLoaded stores jobs and clears loading", () => {
    const s = reducer(initialState(), { type: "jobsLoaded", jobs: threeJobs });
    expect(s.jobs).toHaveLength(3);
    expect(s.loading).toBe(false);
  });

  test("jobsLoaded clamps a now-out-of-range selection", () => {
    const start = { ...initialState(), jobs: threeJobs, selectedIndex: 2 };
    const s = reducer(start, { type: "jobsLoaded", jobs: [job("1")] });
    expect(s.selectedIndex).toBe(0);
  });

  test("jobsLoaded keeps the cursor on the same job when the list reorders", () => {
    const start = { ...initialState(), jobs: threeJobs, selectedIndex: 1 }; // job 2
    const s = reducer(start, { type: "jobsLoaded", jobs: [job("3"), job("1"), job("2")] });
    expect(s.selectedIndex).toBe(2); // job 2 followed to its new position
  });

  test("jobsLoaded falls back to clamping when the selected job disappears", () => {
    const start = { ...initialState(), jobs: threeJobs, selectedIndex: 1 }; // job 2
    const s = reducer(start, { type: "jobsLoaded", jobs: [job("1"), job("3")] });
    expect(s.selectedIndex).toBe(1); // job 2 gone → old index 1 clamped into [0,1]
  });

  test("loadError records the message and stops loading", () => {
    const s = reducer({ ...initialState(), loading: true }, { type: "loadError", error: "boom" });
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
  });
});

describe("reducer — workflows & agents", () => {
  test("workflowsLoaded stores rows and clamps against the active pane", () => {
    const start = { ...initialState("workflows"), selectedIndex: 5 };
    const s = reducer(start, { type: "workflowsLoaded", workflows });
    expect(s.workflows).toHaveLength(2);
    expect(s.selectedIndex).toBe(1);
  });

  test("agentsLoaded stores rows", () => {
    const s = reducer(initialState("agents"), { type: "agentsLoaded", agents });
    expect(s.agents).toHaveLength(1);
  });

  test("activeLength reflects the current pane", () => {
    const base = { ...initialState(), jobs: threeJobs, workflows, agents, software };
    expect(activeLength({ ...base, pane: "jobs" })).toBe(3);
    expect(activeLength({ ...base, pane: "workflows" })).toBe(2);
    expect(activeLength({ ...base, pane: "agents" })).toBe(1);
    // metrics reuses the agents list; software has its own
    expect(activeLength({ ...base, pane: "metrics" })).toBe(1);
    expect(activeLength({ ...base, pane: "software" })).toBe(2);
  });

  test("openDetail pins the right id on every pane, not just jobs", () => {
    const base = {
      ...initialState(),
      jobs: threeJobs,
      workflows,
      agents,
      software,
      selectedIndex: 1,
    };
    // each pane resolves the selected row's id through its own visible* list
    expect(reducer({ ...base, pane: "workflows" }, { type: "openDetail" }).detailId).toBe("w2");
    expect(reducer({ ...base, pane: "software" }, { type: "openDetail" }).detailId).toBe(
      "org/cuda",
    );
    // agents + metrics share the agents list; index 1 is out of range (1 agent)
    // so selection falls back and resolves the only agent at index 0
    const onlyAgent = { ...base, selectedIndex: 0 };
    expect(reducer({ ...onlyAgent, pane: "agents" }, { type: "openDetail" }).detailId).toBe("ag1");
    expect(reducer({ ...onlyAgent, pane: "metrics" }, { type: "openDetail" }).detailId).toBe("ag1");
  });
});

describe("reducer — selection bounds", () => {
  test("selectNext stops at the last row", () => {
    let s = { ...initialState(), jobs: threeJobs, selectedIndex: 0 };
    s = reducer(s, { type: "selectNext" });
    expect(s.selectedIndex).toBe(1);
    s = reducer(s, { type: "selectNext" });
    s = reducer(s, { type: "selectNext" });
    expect(s.selectedIndex).toBe(2);
  });

  test("selectPrev stops at the first row", () => {
    let s = { ...initialState(), jobs: threeJobs, selectedIndex: 1 };
    s = reducer(s, { type: "selectPrev" });
    expect(s.selectedIndex).toBe(0);
    s = reducer(s, { type: "selectPrev" });
    expect(s.selectedIndex).toBe(0);
  });

  test("selection bounds follow the active pane (workflows)", () => {
    let s = { ...initialState("workflows"), workflows, selectedIndex: 0 };
    s = reducer(s, { type: "selectNext" });
    expect(s.selectedIndex).toBe(1);
    s = reducer(s, { type: "selectNext" });
    expect(s.selectedIndex).toBe(1);
  });

  test("selection stays at 0 with an empty list", () => {
    const s = reducer({ ...initialState(), jobs: [] }, { type: "selectNext" });
    expect(s.selectedIndex).toBe(0);
  });
});

describe("reducer — page & jump navigation", () => {
  const tenJobs = Array.from({ length: 10 }, (_, i) => job(String(i + 1)));

  test("selectFirst jumps to the top row", () => {
    const s = reducer(
      { ...initialState(), jobs: tenJobs, selectedIndex: 7 },
      { type: "selectFirst" },
    );
    expect(s.selectedIndex).toBe(0);
  });

  test("selectLast jumps to the bottom row", () => {
    const s = reducer(
      { ...initialState(), jobs: tenJobs, selectedIndex: 0 },
      { type: "selectLast" },
    );
    expect(s.selectedIndex).toBe(9);
  });

  test("pageDown advances by the page size, clamped to the last row", () => {
    let s = { ...initialState(), jobs: tenJobs, selectedIndex: 0 };
    s = reducer(s, { type: "pageDown", size: 4 });
    expect(s.selectedIndex).toBe(4);
    s = reducer(s, { type: "pageDown", size: 4 });
    expect(s.selectedIndex).toBe(8);
    s = reducer(s, { type: "pageDown", size: 4 });
    expect(s.selectedIndex).toBe(9);
  });

  test("pageUp retreats by the page size, clamped to the first row", () => {
    let s = { ...initialState(), jobs: tenJobs, selectedIndex: 9 };
    s = reducer(s, { type: "pageUp", size: 4 });
    expect(s.selectedIndex).toBe(5);
    s = reducer(s, { type: "pageUp", size: 4 });
    expect(s.selectedIndex).toBe(1);
    s = reducer(s, { type: "pageUp", size: 4 });
    expect(s.selectedIndex).toBe(0);
  });

  test("selectLast on an empty list stays at 0", () => {
    const s = reducer({ ...initialState(), jobs: [] }, { type: "selectLast" });
    expect(s.selectedIndex).toBe(0);
  });

  test("page navigation follows the active pane's visible length", () => {
    const s = reducer(
      { ...initialState("workflows"), workflows, selectedIndex: 0 },
      { type: "pageDown", size: 10 },
    );
    expect(s.selectedIndex).toBe(1);
  });
});

describe("reducer — detail view & panes", () => {
  test("openDetail is a no-op with no rows", () => {
    const s = reducer({ ...initialState(), jobs: [] }, { type: "openDetail" });
    expect(s.view).toBe("list");
  });

  test("openDetail enters detail when a row is selected", () => {
    const s = reducer({ ...initialState(), jobs: threeJobs }, { type: "openDetail" });
    expect(s.view).toBe("detail");
  });

  test("setPane switches pane, resets to list view, and resets selection", () => {
    const s = reducer(
      { ...initialState(), view: "detail", selectedIndex: 2 },
      { type: "setPane", pane: "agents" },
    );
    expect(s.pane).toBe("agents");
    expect(s.view).toBe("list");
    expect(s.selectedIndex).toBe(0);
  });

  test("setPane clears the filter but keeps the sort preference", () => {
    const s = reducer(
      { ...initialState(), filter: "wrf", filtering: true, sortKey: "status" },
      { type: "setPane", pane: "agents" },
    );
    expect(s.filter).toBe("");
    expect(s.filtering).toBe(false);
    expect(s.sortKey).toBe("status");
  });

  test("does not mutate the input state (immutability)", () => {
    const start = initialState();
    reducer(start, { type: "jobsLoaded", jobs: threeJobs });
    expect(start.jobs).toHaveLength(0);
  });
});

describe("reducer — submit form", () => {
  test("formOpen opens an empty path input", () => {
    const s = reducer(initialState(), { type: "formOpen" });
    expect(s.form).toEqual({ open: true, path: "", submitting: false });
  });

  test("formInput appends and formBackspace removes characters", () => {
    let s = reducer(initialState(), { type: "formOpen" });
    s = reducer(s, { type: "formInput", text: "j" });
    s = reducer(s, { type: "formInput", text: "ob.json" });
    expect(s.form.path).toBe("job.json");
    s = reducer(s, { type: "formBackspace" });
    expect(s.form.path).toBe("job.jso");
  });

  test("input is ignored once submitting", () => {
    let s = reducer(initialState(), { type: "formOpen" });
    s = reducer(s, { type: "formInput", text: "a" });
    s = reducer(s, { type: "formSubmitting" });
    s = reducer(s, { type: "formInput", text: "b" });
    expect(s.form).toEqual({ open: true, path: "a", submitting: true });
  });

  test("formClose resets the form", () => {
    let s = reducer(initialState(), { type: "formOpen" });
    s = reducer(s, { type: "formInput", text: "x" });
    s = reducer(s, { type: "formClose" });
    expect(s.form).toEqual({ open: false, path: "", submitting: false });
  });
});

describe("reducer — job detail", () => {
  const jobs: TuiJob[] = [{ id: "j1", name: "wrf", status: "running", location: "compute" }];
  const detail = { id: "j1", name: "wrf", status: "completed" as const, exitCode: 0 };

  test("jobDetailLoaded stores data; closeDetail + setPane reset it", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "jobDetailLoading" });
    expect(s.jobDetail.loading).toBe(true);
    s = reducer(s, { type: "jobDetailLoaded", detail });
    expect(s.jobDetail.data?.exitCode).toBe(0);
    expect(reducer({ ...s, view: "detail" }, { type: "closeDetail" }).jobDetail).toEqual({
      loading: false,
    });
    expect(reducer(s, { type: "setPane", pane: "agents" }).jobDetail).toEqual({ loading: false });
  });

  test("jobDetailError records the message", () => {
    const s = reducer({ ...initialState(), jobs }, { type: "jobDetailError", error: "gone" });
    expect(s.jobDetail.error).toBe("gone");
  });

  test("jobStatusLive updates status + sets live while a job detail is open", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openDetail" });
    s = reducer(s, { type: "jobDetailLoaded", detail });
    s = reducer(s, { type: "jobStatusLive", status: "completed" });
    expect(s.jobDetail.data?.status).toBe("completed");
    expect(s.jobDetail.live).toBe(true);
  });

  test("jobStatusLive is ignored when not viewing a job detail", () => {
    const s = reducer({ ...initialState(), jobs }, { type: "jobStatusLive", status: "failed" });
    expect(s.jobDetail.live).toBeUndefined();
  });

  test("jobStatusLive seeds a minimal record from the row when none fetched yet", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openDetail" });
    s = reducer(s, { type: "jobStatusLive", status: "running" });
    expect(s.jobDetail.data?.id).toBe("j1");
    expect(s.jobDetail.data?.status).toBe("running");
  });
});

describe("reducer — workflow detail", () => {
  const detail = {
    id: "w1",
    name: "pipe",
    status: "running" as const,
    steps: [{ id: "build", status: "completed" }],
  };

  test("wfDetailLoaded stores the tree; closeDetail and setPane reset it", () => {
    let s = reducer(initialState("workflows"), { type: "wfDetailLoading" });
    expect(s.wfDetail.loading).toBe(true);
    s = reducer(s, { type: "wfDetailLoaded", detail });
    expect(s.wfDetail.data?.steps).toHaveLength(1);
    const closed = reducer({ ...s, view: "detail" }, { type: "closeDetail" });
    expect(closed.wfDetail).toEqual({ loading: false });
    const switched = reducer(s, { type: "setPane", pane: "jobs" });
    expect(switched.wfDetail).toEqual({ loading: false });
  });

  test("wfDetailError records the message", () => {
    const s = reducer(initialState("workflows"), { type: "wfDetailError", error: "nope" });
    expect(s.wfDetail.error).toBe("nope");
  });
});

describe("reducer — logs view", () => {
  const jobs: TuiJob[] = [{ id: "a1", name: "wrf", status: "running", location: "compute" }];

  test("openLogs enters logs view when a job is selected", () => {
    const s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    expect(s.view).toBe("logs");
  });

  test("openLogs is a no-op with no rows", () => {
    const s = reducer({ ...initialState(), jobs: [] }, { type: "openLogs" });
    expect(s.view).toBe("list");
  });

  test("logsLoaded stores text; closeDetail resets logs + view", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "logsLoaded", text: "hello\n" });
    expect(s.logs.text).toBe("hello\n");
    const closed = reducer(s, { type: "closeDetail" });
    expect(closed.view).toBe("list");
    expect(closed.logs).toEqual({
      loading: false,
      text: "",
      following: false,
      scroll: 0,
      search: "",
    });
  });

  test("in logs view, filter input edits the log search, not the list filter", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    expect(s.logs.search).toBe("");
    s = reducer(s, { type: "filterOpen" });
    s = reducer(s, { type: "filterInput", text: "err" });
    expect(s.logs.search).toBe("err");
    expect(s.filter).toBe("");
    s = reducer(s, { type: "filterBackspace" });
    expect(s.logs.search).toBe("er");
    s = reducer(s, { type: "filterClear" });
    expect(s.logs.search).toBe("");
    expect(s.filtering).toBe(false);
  });

  test("logsError records the message", () => {
    const s = reducer({ ...initialState(), jobs }, { type: "logsError", error: "nope" });
    expect(s.logs.error).toBe("nope");
  });

  test("toggleLogsFollow flips follow; logsLoaded preserves it; close resets it", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "toggleLogsFollow" });
    expect(s.logs.following).toBe(true);
    s = reducer(s, { type: "logsLoaded", text: "new\n" });
    expect(s.logs.following).toBe(true);
    expect(s.logs.text).toBe("new\n");
    const closed = reducer(s, { type: "closeDetail" });
    expect(closed.logs.following).toBe(false);
  });

  test("openLogs resets a stale follow flag", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "toggleLogsFollow" });
    const reopened = reducer(s, { type: "openLogs" });
    expect(reopened.logs.following).toBe(false);
  });

  test("logsScrollBy moves the offset from the bottom, clamped to [0, max]", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "logsScrollBy", delta: 5, max: 10 });
    expect(s.logs.scroll).toBe(5);
    s = reducer(s, { type: "logsScrollBy", delta: 100, max: 10 });
    expect(s.logs.scroll).toBe(10);
    s = reducer(s, { type: "logsScrollBy", delta: -100, max: 10 });
    expect(s.logs.scroll).toBe(0);
  });

  test("scrolling up pauses follow so the view doesn't jump back to the tail", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "toggleLogsFollow" });
    expect(s.logs.following).toBe(true);
    s = reducer(s, { type: "logsScrollBy", delta: 3, max: 10 });
    expect(s.logs.following).toBe(false);
    expect(s.logs.scroll).toBe(3);
  });

  test("turning follow on snaps back to the tail (scroll 0)", () => {
    let s = reducer({ ...initialState(), jobs }, { type: "openLogs" });
    s = reducer(s, { type: "logsScrollBy", delta: 4, max: 10 });
    s = reducer(s, { type: "toggleLogsFollow" });
    expect(s.logs.following).toBe(true);
    expect(s.logs.scroll).toBe(0);
  });
});

describe("reducer — multi-select marks", () => {
  test("toggleMark adds then removes the selected item's id", () => {
    const base = { ...initialState(), jobs: threeJobs, selectedIndex: 1 };
    const marked = reducer(base, { type: "toggleMark" });
    expect([...marked.marked]).toEqual(["2"]);
    const unmarked = reducer(marked, { type: "toggleMark" });
    expect([...unmarked.marked]).toEqual([]);
  });

  test("toggleMark does not mutate the previous state's set (immutability)", () => {
    const base = { ...initialState(), jobs: threeJobs, selectedIndex: 0 };
    const next = reducer(base, { type: "toggleMark" });
    expect(base.marked.size).toBe(0); // original untouched
    expect([...next.marked]).toEqual(["1"]);
  });

  test("clearMarks empties the set", () => {
    const s = reducer(
      { ...initialState(), jobs: threeJobs, marked: new Set(["1", "2"]) },
      { type: "clearMarks" },
    );
    expect(s.marked.size).toBe(0);
  });

  test("setPane clears marks (they are jobs-pane context)", () => {
    const s = reducer(
      { ...initialState(), jobs: threeJobs, marked: new Set(["1"]) },
      { type: "setPane", pane: "agents" },
    );
    expect(s.marked.size).toBe(0);
  });

  test("confirmBulkCancelOpen opens the confirm with the marked count", () => {
    const s = reducer({ ...initialState() }, { type: "confirmBulkCancelOpen", count: 3 });
    expect(s.confirm).toMatchObject({ open: true, bulkCount: 3 });
    const closed = reducer(s, { type: "confirmClose" });
    expect(closed.confirm.open).toBe(false);
    expect(closed.confirm.bulkCount).toBeUndefined();
  });
});

describe("detail pinning (poll-drift safety)", () => {
  test("pinnedItem follows the id, not the index", () => {
    const rows = threeJobs; // ids "1","2","3"
    // detail pinned to id "2"; even if it's now at a different index, we get it.
    expect(pinnedItem(rows, "2", 0)?.id).toBe("2");
    // reordered list — still resolves by id
    expect(pinnedItem([...rows].reverse(), "2", 0)?.id).toBe("2");
  });

  test("pinnedItem falls back to the selected index when id is gone/unset", () => {
    expect(pinnedItem(threeJobs, undefined, 1)?.id).toBe("2");
    expect(pinnedItem(threeJobs, "gone", 2)?.id).toBe("3");
  });

  test("openDetail pins detailId to the selection; close/setPane clear it", () => {
    const s = reducer(
      { ...initialState(), jobs: threeJobs, selectedIndex: 1 },
      { type: "openDetail" },
    );
    expect(s.detailId).toBe("2");
    expect(reducer(s, { type: "closeDetail" }).detailId).toBeUndefined();
    expect(reducer(s, { type: "setPane", pane: "agents" }).detailId).toBeUndefined();
  });

  test("openLogs pins detailId too", () => {
    const s = reducer(
      { ...initialState(), jobs: threeJobs, selectedIndex: 2 },
      { type: "openLogs" },
    );
    expect(s.detailId).toBe("3");
  });
});

describe("reducer — notice", () => {
  test("notice sets the message; clearNotice removes it", () => {
    let s = reducer(initialState(), { type: "notice", message: "Cancelled 12345" });
    expect(s.notice).toBe("Cancelled 12345");
    s = reducer(s, { type: "clearNotice" });
    expect(s.notice).toBeUndefined();
  });
});

describe("reducer — help overlay", () => {
  test("helpToggle flips; helpClose forces closed", () => {
    let s = reducer(initialState(), { type: "helpToggle" });
    expect(s.helpOpen).toBe(true);
    s = reducer(s, { type: "helpToggle" });
    expect(s.helpOpen).toBe(false);
    s = reducer({ ...initialState(), helpOpen: true }, { type: "helpClose" });
    expect(s.helpOpen).toBe(false);
  });
});

describe("reducer — cancel confirmation", () => {
  test("confirmCancelOpen stores the target; confirmClose resets it", () => {
    let s = reducer(initialState(), {
      type: "confirmCancelOpen",
      jobId: "12345",
      jobName: "wrf",
    });
    expect(s.confirm).toEqual({ open: true, jobId: "12345", jobName: "wrf" });
    s = reducer(s, { type: "confirmClose" });
    expect(s.confirm).toEqual({ open: false, jobId: "", jobName: "" });
  });
});

describe("filtering", () => {
  const jobs: TuiJob[] = [
    { id: "a1", name: "wrf-ens", status: "running", location: "compute" },
    { id: "b2", name: "mesh-prep", status: "queued", location: "gpu" },
    { id: "c3", name: "wrf-post", status: "completed", location: "compute" },
  ];

  test("visibleJobs filters by name/id/location/status, case-insensitive", () => {
    const base = { ...initialState(), jobs };
    expect(visibleJobs({ ...base, filter: "wrf" }).map((j) => j.id)).toEqual(["a1", "c3"]);
    expect(visibleJobs({ ...base, filter: "GPU" }).map((j) => j.id)).toEqual(["b2"]);
    expect(visibleJobs({ ...base, filter: "queued" }).map((j) => j.id)).toEqual(["b2"]);
    expect(visibleJobs({ ...base, filter: "" })).toHaveLength(3);
  });

  test("activeLength reflects the filtered count", () => {
    const s = { ...initialState(), jobs, filter: "wrf" };
    expect(activeLength(s)).toBe(2);
  });

  test("filterOpen → filterInput builds the filter and resets selection", () => {
    let s = { ...initialState(), jobs, selectedIndex: 2 };
    s = reducer(s, { type: "filterOpen" });
    expect(s.filtering).toBe(true);
    s = reducer(s, { type: "filterInput", text: "w" });
    s = reducer(s, { type: "filterInput", text: "rf" });
    expect(s.filter).toBe("wrf");
    expect(s.selectedIndex).toBe(0);
  });

  test("filterBackspace trims; filterInput ignored when not in input mode", () => {
    let s = { ...initialState(), filter: "wrf", filtering: true };
    s = reducer(s, { type: "filterBackspace" });
    expect(s.filter).toBe("wr");
    s = reducer(s, { type: "filterCommit" });
    expect(s.filtering).toBe(false);
    const ignored = reducer(s, { type: "filterInput", text: "x" });
    expect(ignored.filter).toBe("wr");
  });

  test("filterClear empties the filter and exits input mode", () => {
    const s = reducer(
      { ...initialState(), filter: "wrf", filtering: true, selectedIndex: 1 },
      { type: "filterClear" },
    );
    expect(s.filter).toBe("");
    expect(s.filtering).toBe(false);
    expect(s.selectedIndex).toBe(0);
  });

  test("visibleWorkflows and visibleAgents filter too", () => {
    const wfState = {
      ...initialState("workflows"),
      workflows: [
        { id: "w1", name: "sweep", status: "running" as const },
        { id: "w2", name: "train", status: "failed" as const },
      ],
      filter: "train",
    };
    expect(visibleWorkflows(wfState).map((w) => w.id)).toEqual(["w2"]);

    const agState = {
      ...initialState("agents"),
      agents: [
        { id: "ag1", site: "north", scheduler: "slurm 23", status: "running" as const },
        { id: "ag2", site: "south", scheduler: "pbs 2024", status: "failed" as const },
      ],
      filter: "pbs",
    };
    expect(visibleAgents(agState).map((a) => a.id)).toEqual(["ag2"]);
  });
});

describe("sorting", () => {
  const jobs: TuiJob[] = [
    { id: "3", name: "charlie", status: "queued", location: "c" },
    { id: "1", name: "alpha", status: "running", location: "a" },
    { id: "2", name: "bravo", status: "completed", location: "b" },
  ];

  test("cycleSort rotates default → name → status → default and resets selection", () => {
    let s = { ...initialState(), jobs, selectedIndex: 2 };
    expect(s.sortKey).toBe("default");
    s = reducer(s, { type: "cycleSort" });
    expect(s.sortKey).toBe("name");
    expect(s.selectedIndex).toBe(0);
    s = reducer(s, { type: "cycleSort" });
    expect(s.sortKey).toBe("status");
    s = reducer(s, { type: "cycleSort" });
    expect(s.sortKey).toBe("default");
  });

  test("default keeps backend order; name sorts alphabetically", () => {
    const base = { ...initialState(), jobs };
    expect(visibleJobs({ ...base, sortKey: "default" }).map((j) => j.name)).toEqual([
      "charlie",
      "alpha",
      "bravo",
    ]);
    expect(visibleJobs({ ...base, sortKey: "name" }).map((j) => j.name)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  test("status sort groups by status; sort applies after filter", () => {
    const base = { ...initialState(), jobs };
    expect(visibleJobs({ ...base, sortKey: "status" }).map((j) => j.status)).toEqual([
      "completed",
      "queued",
      "running",
    ]);
    // filter then sort: only names containing "a" (alpha, bravo, charlie all have 'a'),
    // narrow to "ph" → alpha only.
    expect(visibleJobs({ ...base, filter: "ph", sortKey: "name" }).map((j) => j.name)).toEqual([
      "alpha",
    ]);
  });
});

describe("nextEnabledPane", () => {
  const allCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: true,
  };
  const localCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: false,
    workflows: false,
    agents: false,
    metrics: false,
    software: false,
    ssh: false,
  };

  test("cycles through all enabled panes", () => {
    expect(nextEnabledPane("jobs", allCaps)).toBe("workflows");
    expect(nextEnabledPane("workflows", allCaps)).toBe("agents");
    expect(nextEnabledPane("agents", allCaps)).toBe("metrics");
    expect(nextEnabledPane("metrics", allCaps)).toBe("software");
    expect(nextEnabledPane("software", allCaps)).toBe("jobs");
  });

  test("skips disabled panes in local mode (only jobs)", () => {
    expect(nextEnabledPane("jobs", localCaps)).toBe("jobs");
  });
});

describe("paneAtPosition", () => {
  const allCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: true,
  };
  const localCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: false,
    workflows: false,
    agents: false,
    metrics: false,
    software: false,
    ssh: false,
  };

  test("maps a 1-based position to the pane in tab order when enabled", () => {
    expect(paneAtPosition(1, allCaps)).toBe("jobs");
    expect(paneAtPosition(4, allCaps)).toBe("metrics");
    expect(paneAtPosition(5, allCaps)).toBe("software");
  });

  test("returns undefined for a disabled pane or out-of-range position", () => {
    expect(paneAtPosition(2, localCaps)).toBeUndefined();
    expect(paneAtPosition(9, allCaps)).toBeUndefined();
    expect(paneAtPosition(0, allCaps)).toBeUndefined();
  });
});

describe("resolveInitialPane", () => {
  const allCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: true,
  };
  const localMetricsCaps: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: false,
    agents: false,
    metrics: true,
    software: false,
    ssh: false,
  };

  test("honours a requested pane when it is enabled", () => {
    expect(resolveInitialPane("metrics", allCaps)).toBe("metrics");
    expect(resolveInitialPane("metrics", localMetricsCaps)).toBe("metrics");
  });

  test("falls back to the first enabled pane when none requested", () => {
    expect(resolveInitialPane(undefined, allCaps)).toBe("jobs");
  });

  test("falls back when the requested pane is disabled in this mode", () => {
    expect(resolveInitialPane("workflows", localMetricsCaps)).toBe("jobs");
  });
});
