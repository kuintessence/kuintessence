import { describe, expect, test } from "bun:test";
import type { TuiBackend, TuiBackendCapabilities } from "./backend/types";
import { ConfirmPrompt, FilterBar, Footer, Header, HelpOverlay, SubmitForm } from "./chrome";
import { render } from "./test-render";

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

/** A no-op backend stub — Header only reads `info` + `capabilities`. */
function backend(): TuiBackend {
  const unsupported = async () => {
    throw new Error("not used in chrome tests");
  };
  return {
    info: { mode: "remote", target: "http://server.test" },
    capabilities: allCaps,
    listJobs: unsupported,
    cancelJob: unsupported,
    getJobDetail: unsupported,
    subscribeJobStatus: () => () => {},
    submitFromSpec: unsupported,
    getJobLogs: unsupported,
    listWorkflows: unsupported,
    submitWorkflow: unsupported,
    getWorkflowDetail: unsupported,
    subscribeWorkflowStatus: () => () => {},
    listAgents: unsupported,
    listSoftware: unsupported,
  };
}

describe("Header", () => {
  test("renders all pane tabs and the connection target", async () => {
    const { lastFrame } = await render(<Header backend={backend()} pane="jobs" />);
    const frame = lastFrame() ?? "";
    for (const tab of ["Jobs", "Workflows", "Agents", "Metrics", "Software"]) {
      expect(frame).toContain(tab);
    }
    // Tabs are numbered for the 1–5 jump shortcut.
    expect(frame).toContain("1:Jobs");
    expect(frame).toContain("5:Software");
    expect(frame).toContain("remote:http://server.test");
    const headerLine = frame.split("\n").find((line) => line.includes("1:Jobs")) ?? "";
    expect(headerLine).toContain("5:Software");
    expect(headerLine).toContain("remote:http://server.test");
  });
});

describe("Footer", () => {
  const base = {
    notice: undefined,
    canSubmit: true,
    canWorkflows: true,
    canLogs: true,
    canSsh: true,
    sortKey: "default" as const,
  };

  test("jobs pane shows job actions; logs/workflow/agent-only hints are scoped", async () => {
    const { lastFrame } = await render(<Footer {...base} view="list" pane="jobs" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("x cancel");
    expect(frame).toContain("space mark"); // multi-select hint (jobs)
    expect(frame).toContain("s submit");
    expect(frame).toContain("l logs");
    expect(frame).not.toContain("c ssh"); // ssh is agents-only
  });

  test("agents pane shows ssh, not job-only hints", async () => {
    const { lastFrame } = await render(<Footer {...base} view="list" pane="agents" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("c ssh");
    expect(frame).not.toContain("x cancel");
    expect(frame).not.toContain("l logs");
  });

  test("workflows pane offers submit", async () => {
    const { lastFrame } = await render(<Footer {...base} view="list" pane="workflows" />);
    expect(lastFrame() ?? "").toContain("s submit");
  });

  test("logs view shows follow/re-tail keys", async () => {
    const { lastFrame } = await render(<Footer {...base} view="logs" pane="jobs" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("f follow");
    expect(frame).toContain("r re-tail");
  });

  test("active sort is reflected; a notice line shows above the keys", async () => {
    const { lastFrame } = await render(
      <Footer {...base} view="list" pane="jobs" sortKey="status" notice="Cancelled 1" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("o sort:status");
    expect(frame).toContain("Cancelled 1");
  });

  test("shows how long ago the data was last updated", async () => {
    const now = 1_000_000;
    const { lastFrame } = await render(
      <Footer {...base} view="list" pane="jobs" lastUpdatedAt={now - 5_000} now={now} />,
    );
    expect(lastFrame() ?? "").toContain("updated 5s ago");
  });

  test("omits the freshness hint until the first load completes", async () => {
    const { lastFrame } = await render(
      <Footer {...base} view="list" pane="jobs" now={1_000_000} />,
    );
    expect(lastFrame() ?? "").not.toContain("updated");
  });
});

describe("FilterBar", () => {
  test("renders nothing when idle", async () => {
    expect((await render(<FilterBar filter="" filtering={false} />)).lastFrame()).toBe("");
  });
  test("shows the query + cursor while filtering", async () => {
    const { lastFrame } = await render(<FilterBar filter="wrf" filtering={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/wrf");
    expect(frame).toContain("enter apply");
  });
});

describe("HelpOverlay", () => {
  test("lists the always-available keybindings and the mode", async () => {
    const { lastFrame } = await render(<HelpOverlay mode="local" canLogs canSsh canWorkflows />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("keybindings (local mode)");
    expect(frame).toContain("filter list");
    expect(frame).toContain("grep logs");
    expect(frame).toContain("jump to top / bottom");
    expect(frame).toContain("page up / down");
    expect(frame).toContain("scroll logs");
    expect(frame).toContain("jump to pane by number");
    // version is shown for support / bug-report context
    expect(frame).toMatch(/v\d+\.\d+\.\d+/);
    // enter opens detail on every pane except the metrics dashboard
    expect(frame).toContain("open detail (not metrics)");
    // multi-select marking is documented
    expect(frame).toContain("mark/unmark job for bulk action");
  });

  test("only advertises keys the active mode actually supports", async () => {
    // Remote with all capabilities shows ssh + logs + workflow submit.
    const remote =
      (await render(<HelpOverlay mode="remote" canLogs canSsh canWorkflows />)).lastFrame() ?? "";
    expect(remote).toContain("open an SSH shell");
    expect(remote).toContain("view job logs");
    expect(remote).toContain("job/workflow");

    // All-in-one local node: no Server → no SSH; this adapter exposes no logs.
    const local =
      (
        await render(
          <HelpOverlay mode="local" canLogs={false} canSsh={false} canWorkflows={false} />,
        )
      ).lastFrame() ?? "";
    expect(local).not.toContain("open an SSH shell");
    expect(local).not.toContain("view job logs");
    // submit is job-only without workflows, and the wording reflects that
    expect(local).toContain("submit a job from a file");
    expect(local).not.toContain("job/workflow");
  });
});

describe("ConfirmPrompt / SubmitForm", () => {
  test("ConfirmPrompt names the target job", async () => {
    const { lastFrame } = await render(<ConfirmPrompt jobId="12345" jobName="wrf" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Cancel job wrf (12345)?");
    expect(frame).toContain("y confirm");
  });

  test("ConfirmPrompt shows the marked-count for a bulk cancel (pluralized)", async () => {
    expect(
      (await render(<ConfirmPrompt jobId="" jobName="" bulkCount={3} />)).lastFrame() ?? "",
    ).toContain("Cancel 3 marked jobs?");
    expect(
      (await render(<ConfirmPrompt jobId="" jobName="" bulkCount={1} />)).lastFrame() ?? "",
    ).toContain("Cancel 1 marked job?");
  });

  test("SubmitForm title reflects job vs workflow and shows the path", async () => {
    expect(
      (await render(<SubmitForm path="/tmp/j.json" submitting={false} kind="job" />)).lastFrame() ??
        "",
    ).toContain("Submit job from spec file");
    const wf = await render(<SubmitForm path="/tmp/w.yaml" submitting={false} kind="workflow" />);
    const frame = wf.lastFrame() ?? "";
    expect(frame).toContain("Submit workflow from YAML file");
    expect(frame).toContain("/tmp/w.yaml");
  });

  test("SubmitForm shows a submitting state", async () => {
    const { lastFrame } = await render(<SubmitForm path="/tmp/j" submitting={true} kind="job" />);
    expect(lastFrame() ?? "").toContain("submitting…");
  });
});
