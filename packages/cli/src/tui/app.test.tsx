import { describe, expect, test } from "bun:test";
import { act } from "react";
import { App } from "./app";
import type { TuiBackend, TuiJob } from "./backend/types";
import { render } from "./test-render";

function fakeBackend(over: Partial<TuiBackend> = {}): TuiBackend {
  const jobs: TuiJob[] = [
    { id: "a1b2", name: "wrf-ens-01", status: "running", location: "compute", submittedAt: "t" },
    { id: "c3d4", name: "mesh-prep", status: "queued", location: "gpu" },
  ];
  return {
    info: { mode: "remote", target: "http://server.test" },
    capabilities: {
      jobs: true,
      submit: true,
      logs: true,
      workflows: true,
      agents: true,
      metrics: true,
      software: true,
      ssh: true,
    },
    async listJobs() {
      return jobs;
    },
    async cancelJob() {},
    async getJobDetail(id: string) {
      return { id, name: "wrf-ens-01", status: "running" as const, schedulerJobId: "99" };
    },
    subscribeJobStatus() {
      return () => {};
    },
    async submitFromSpec() {
      return { id: "new-1", name: "submitted" };
    },
    async getJobLogs() {
      return "line 1\nline 2\n";
    },
    async listWorkflows() {
      return [{ id: "w1", name: "pipeline-01", status: "running" as const }];
    },
    async submitWorkflow() {
      return { id: "run-9", name: "pipeline-01" };
    },
    async getWorkflowDetail(id: string) {
      return {
        id,
        name: "pipeline-01",
        status: "running" as const,
        steps: [{ id: "prep", status: "completed" }],
      };
    },
    subscribeWorkflowStatus() {
      return () => {};
    },
    async listAgents() {
      return [
        { id: "ag-n", site: "north", scheduler: "slurm 23.02.7", status: "running" as const },
      ];
    },
    async listSoftware() {
      return [
        {
          id: "public/openmpi",
          name: "openmpi",
          source: "spack",
          versions: ["4.1.6"],
          lifecycle: "installed",
          spec: "openmpi@4.1.6",
        },
      ];
    },
    ...over,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 1000;
  let frame = lastFrame() ?? "";
  while (Date.now() < deadline) {
    if (predicate(frame)) return frame;
    await tick(20);
    frame = lastFrame() ?? "";
  }
  return frame;
}

describe("App", () => {
  test("renders header tabs and the backend target", async () => {
    const { lastFrame, unmount } = await render(<App backend={fakeBackend()} pollMs={10_000} />);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Jobs");
    expect(frame).toContain("Workflows");
    expect(frame).toContain("remote:http://server.test");
    unmount();
  });

  test("loads and renders the jobs table after the initial fetch", async () => {
    const { lastFrame, unmount } = await render(<App backend={fakeBackend()} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("wrf-ens-01"));
    expect(frame).toContain("wrf-ens-01");
    expect(frame).toContain("mesh-prep");
    expect(frame).toContain("STATUS");
    unmount();
  });

  test("renders a local-mode target and the empty-queue notice", async () => {
    const backend = fakeBackend({
      info: { mode: "local", target: "slurm 23.02.7" },
      capabilities: {
        jobs: true,
        submit: true,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: false,
        ssh: false,
      },
      async listJobs() {
        return [];
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) =>
      f.includes("No jobs found in the local scheduler queue."),
    );
    expect(frame).toContain("local:slurm 23.02.7");
    expect(frame).toContain("No jobs found in the local scheduler queue.");
    unmount();
  });

  test("starting in workflows pane loads and renders workflow runs", async () => {
    // The initial pane is the first enabled one; force a workflows-only backend
    // so the app boots straight into the workflows pane.
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: true,
        agents: false,
        metrics: false,
        software: false,
        ssh: false,
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("pipeline-01"));
    expect(frame).toContain("pipeline-01");
    expect(frame).toContain("RUN ID");
    // workflows pane offers submit (YAML) too
    expect(frame).toContain("s submit");
    unmount();
  });

  test("starting in agents pane loads and renders agents, shows ssh hint", async () => {
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: true,
        metrics: true,
        software: false,
        ssh: true,
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("ag-n"));
    expect(frame).toContain("ag-n");
    expect(frame).toContain("SCHEDULER");
    expect(frame).toContain("c ssh");
    unmount();
  });

  test("Ctrl-C never invokes the Agents SSH shortcut", async () => {
    let sshAgentId: string | undefined;
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: true,
        metrics: false,
        software: false,
        ssh: true,
      },
    });
    const { lastFrame, mockInput, flush, unmount } = await render(
      <App
        backend={backend}
        pollMs={10_000}
        onSsh={(agentId) => {
          sshAgentId = agentId;
        }}
      />,
    );
    await waitForFrame(lastFrame, (frame) => frame.includes("ag-n"));
    act(() => mockInput.pressKey("c", { ctrl: true }));
    await flush();
    expect(sshAgentId).toBeUndefined();
    unmount();
  });

  test("starting in metrics pane renders agent resource bars", async () => {
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: false,
        metrics: true,
        software: false,
        ssh: false,
      },
      async listAgents() {
        return [
          {
            id: "ag-n",
            site: "north",
            scheduler: "slurm 23.02.7",
            status: "running" as const,
            cpuPercent: 75,
            memoryUsedMb: 2048,
            memoryTotalMb: 8192,
            queueDepth: 2,
            maxConcurrentJobs: 8,
          },
        ];
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("ag-n (north)"));
    expect(frame).toContain("ag-n (north)");
    expect(frame).toContain("CPU");
    expect(frame).toContain("75%");
    unmount();
  });

  test("starting in software pane loads and renders software", async () => {
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: true,
        ssh: false,
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("openmpi"));
    expect(frame).toContain("openmpi");
    expect(frame).toContain("LIFECYCLE");
    unmount();
  });

  test("commits Software search to the server and navigates catalog pages", async () => {
    const requests: Array<{ page?: number; query?: string }> = [];
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: true,
        ssh: false,
      },
      async listSoftwarePage(query) {
        requests.push(query);
        return {
          items: [
            {
              id: "catalog:upstream:cuda",
              name: query.query || "openmpi",
              source: "upstream",
              versions: ["12.4"],
              lifecycle: "catalog",
            },
          ],
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 24,
          totalCount: 48,
          totalPages: 2,
        };
      },
    });
    const { lastFrame, mockInput, flush, unmount } = await render(
      <App backend={backend} pollMs={10_000} />,
    );
    await waitForFrame(lastFrame, (frame) => frame.includes("openmpi"));

    act(() => mockInput.pressKey("/"));
    await flush();
    for (const char of "cuda") {
      act(() => mockInput.pressKey(char));
      await flush();
    }
    act(() => mockInput.pressEnter());
    await flush();
    await waitForFrame(lastFrame, (frame) => frame.includes("cuda"));
    expect(requests.at(-1)).toMatchObject({ page: 1, query: "cuda" });

    act(() => mockInput.pressKey("]"));
    await flush();
    await waitForFrame(lastFrame, (frame) => frame.includes("page 2/2"));
    expect(requests.at(-1)).toMatchObject({ page: 2, query: "cuda" });
    unmount();
  });

  test("ignores a stale Software page response after a newer search", async () => {
    let resolveOldPage:
      | ((page: Awaited<ReturnType<NonNullable<TuiBackend["listSoftwarePage"]>>>) => void)
      | undefined;
    let calls = 0;
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: true,
        ssh: false,
      },
      async listSoftwarePage(query) {
        calls += 1;
        if (calls === 2) {
          return new Promise((resolve) => {
            resolveOldPage = resolve;
          });
        }
        return {
          items: [
            {
              id: `catalog:upstream:${query.query ?? "initial"}`,
              name: query.query ?? "initial",
              source: "upstream",
              versions: ["1.0"],
              lifecycle: "catalog",
            },
          ],
          page: query.page ?? 1,
          pageSize: 24,
          totalCount: 48,
          totalPages: 2,
        };
      },
    });
    const { lastFrame, mockInput, flush, unmount } = await render(
      <App backend={backend} pollMs={10_000} />,
    );
    await waitForFrame(lastFrame, (frame) => frame.includes("initial"));

    act(() => mockInput.pressKey("]"));
    await flush();
    act(() => mockInput.pressKey("/"));
    await flush();
    for (const char of "new") {
      act(() => mockInput.pressKey(char));
      await flush();
    }
    act(() => mockInput.pressEnter());
    await flush();
    await waitForFrame(lastFrame, (frame) => frame.includes("new"));

    resolveOldPage?.({
      items: [
        {
          id: "catalog:upstream:stale",
          name: "stale",
          source: "upstream",
          versions: ["0.1"],
          lifecycle: "catalog",
        },
      ],
      page: 2,
      pageSize: 24,
      totalCount: 48,
      totalPages: 2,
    });
    await tick();
    expect(lastFrame() ?? "").toContain("new");
    expect(lastFrame() ?? "").not.toContain("stale");
    expect(lastFrame() ?? "").toContain("page 1/2");
    unmount();
  });

  test("does not supersede a slow Software request with the same poll intent", async () => {
    let calls = 0;
    let resolvePage:
      | ((page: Awaited<ReturnType<NonNullable<TuiBackend["listSoftwarePage"]>>>) => void)
      | undefined;
    const pagePromise = new Promise<
      Awaited<ReturnType<NonNullable<TuiBackend["listSoftwarePage"]>>>
    >((resolve) => {
      resolvePage = resolve;
    });
    const backend = fakeBackend({
      capabilities: {
        jobs: false,
        submit: false,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: true,
        ssh: false,
      },
      async listSoftwarePage() {
        calls += 1;
        return pagePromise;
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10} />);

    await tick(35);
    expect(calls).toBe(1);
    resolvePage?.({
      items: [
        {
          id: "catalog:upstream:slow",
          name: "slow",
          source: "upstream",
          versions: ["1.0"],
          lifecycle: "catalog",
        },
      ],
      page: 1,
      pageSize: 24,
      totalCount: 1,
      totalPages: 1,
    });
    const frame = await waitForFrame(lastFrame, (value) => value.includes("slow"));
    expect(frame).toContain("slow");
    unmount();
  });

  test("local mode disables workflows/agents tabs (dimmed) and shows only jobs", async () => {
    const backend = fakeBackend({
      info: { mode: "local", target: "slurm 23.02.7" },
      capabilities: {
        jobs: true,
        submit: true,
        logs: false,
        workflows: false,
        agents: false,
        metrics: false,
        software: false,
        ssh: false,
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("wrf-ens-01"));
    // jobs still render; the header still lists all three tab labels (dimmed).
    expect(frame).toContain("wrf-ens-01");
    expect(frame).toContain("Jobs");
    unmount();
  });

  test("surfaces a backend error in the pane", async () => {
    const backend = fakeBackend({
      async listJobs() {
        throw new Error("controller unreachable");
      },
    });
    const { lastFrame, unmount } = await render(<App backend={backend} pollMs={10_000} />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("controller unreachable"));
    expect(frame).toContain("controller unreachable");
    unmount();
  });
});
