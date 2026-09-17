import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createGuiServer } from "../gui-serve/server";
import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiSoftware,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "../tui/backend/types";
import { parseGuiPort } from "./gui";

describe("parseGuiPort", () => {
  it("accepts a valid port", () => {
    expect(parseGuiPort("8799")).toBe(8799);
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseGuiPort("0")).toThrow();
    expect(() => parseGuiPort("70000")).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => parseGuiPort("abc")).toThrow();
    expect(() => parseGuiPort("80.5")).toThrow();
  });
});

class StubBackend implements TuiBackend {
  readonly info: TuiBackendInfo = { mode: "local", target: "slurm 23.02" };
  readonly capabilities: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: false,
    agents: true,
    metrics: true,
    software: true,
    ssh: false,
  };
  listJobs(): Promise<TuiJob[]> {
    return Promise.resolve([]);
  }
  cancelJob(): Promise<void> {
    return Promise.resolve();
  }
  getJobDetail(id: string): Promise<TuiJobDetail> {
    return Promise.resolve({ id, name: "x", status: "running" });
  }
  subscribeJobStatus(): () => void {
    return () => {};
  }
  submitFromSpec(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "1" });
  }
  getJobLogs(): Promise<string> {
    return Promise.resolve("");
  }
  listWorkflows(): Promise<TuiWorkflowRun[]> {
    return Promise.resolve([]);
  }
  submitWorkflow(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "w1" });
  }
  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    return Promise.resolve({ id, name: "x", status: "running", steps: [] });
  }
  subscribeWorkflowStatus(): () => void {
    return () => {};
  }
  listAgents(): Promise<TuiAgent[]> {
    return Promise.resolve([]);
  }
  listSoftware(): Promise<TuiSoftware[]> {
    return Promise.resolve([]);
  }
}

describe("kq gui serve Bun.serve smoke", () => {
  it("serves /api/auth/oidc/config-public over a real ephemeral port", async () => {
    const server = createGuiServer(new StubBackend(), {});
    const listener = Bun.serve({ port: 0, fetch: server.fetch });
    try {
      const res = await fetch(
        `http://${listener.hostname}:${listener.port}/api/auth/oidc/config-public`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false, providerName: "" });
    } finally {
      listener.stop(true);
    }
  });
});

describe("kq gui serve error routing", () => {
  it("reports an arg-validation error directly, not as a missing-scheduler failure", async () => {
    const cli = resolve(import.meta.dir, "../index.ts");
    const proc = Bun.spawn(["bun", "run", cli, "gui", "serve", "--port", "0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;

    expect(exit).toBe(1);
    expect(out).toContain('Invalid --port "0"');
    // A bad CLI flag must NOT be dressed up as a missing-scheduler problem.
    expect(out).not.toContain("Ensure a scheduler CLI");
    expect(out).not.toContain("gui serve (local)");
  }, 30_000);
});
