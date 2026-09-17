import { describe, expect, test } from "bun:test";
import { createAgentServer } from "../../agent-serve/server";
import { ExternalAgentBackend } from "./external-agent";
import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "./types";
import { UnsupportedInModeError } from "./types";

/**
 * Round-trip e2e: the real {@link createAgentServer} (the `kq agent serve`
 * handler) over an in-memory {@link TuiBackend}, bound on an ephemeral port via
 * `Bun.serve`, driven by a real {@link ExternalAgentBackend} client. This proves
 * the client ↔ server wire contract end to end — not a mocked fetch.
 */

const CAPS: TuiBackendCapabilities = {
  jobs: true,
  submit: true,
  logs: false,
  workflows: false,
  agents: false,
  metrics: false,
  software: true,
  ssh: false,
};

/** Minimal in-memory backend: a couple of jobs, submit appends, cancel removes,
 *  and the Server-only surfaces throw {@link UnsupportedInModeError}. */
function fakeBackend(): TuiBackend {
  const jobs: TuiJob[] = [
    { id: "j1", name: "wrf", status: "running", location: "debug" },
    { id: "j2", name: "lmp", status: "queued", location: "batch" },
  ];
  const info: TuiBackendInfo = { mode: "local", target: "slurm 23.02" };
  return {
    info,
    capabilities: CAPS,
    async listJobs() {
      return [...jobs];
    },
    async cancelJob(id) {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) jobs.splice(i, 1);
    },
    async getJobDetail(id): Promise<TuiJobDetail> {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new Error(`no such job ${id}`);
      return { id: j.id, name: j.name, status: j.status, node: "node01" };
    },
    subscribeJobStatus() {
      return () => {};
    },
    async submitFromSpec(raw): Promise<TuiSubmitResult> {
      const parsed = JSON.parse(raw) as { name?: string };
      const id = `j${jobs.length + 1}`;
      jobs.push({ id, name: parsed.name ?? "job", status: "queued", location: "batch" });
      return { id, name: parsed.name };
    },
    async getJobLogs(): Promise<string> {
      throw new UnsupportedInModeError("logs", "local");
    },
    async listWorkflows(): Promise<TuiWorkflowRun[]> {
      throw new UnsupportedInModeError("workflows", "local");
    },
    async submitWorkflow(): Promise<TuiSubmitResult> {
      throw new UnsupportedInModeError("workflows", "local");
    },
    async getWorkflowDetail(): Promise<TuiWorkflowDetail> {
      throw new UnsupportedInModeError("workflows", "local");
    },
    subscribeWorkflowStatus() {
      return () => {};
    },
    async listAgents() {
      throw new UnsupportedInModeError("agents", "local");
    },
    async listSoftware() {
      return [];
    },
  } satisfies TuiBackend;
}

describe("ExternalAgentBackend ↔ createAgentServer (real Bun.serve round-trip)", () => {
  test("drives jobs lifecycle, surfaces 501/401 honestly", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: createAgentServer(fakeBackend(), { token: "t" }).fetch,
    });
    try {
      const base = `http://localhost:${server.port}`;
      const client = await ExternalAgentBackend.create(base, { token: "t" });

      // create() read the agent's real capabilities + tagged the URL as target.
      expect(client.capabilities).toEqual(CAPS);
      expect(client.info).toEqual({ mode: "remote", target: `agent ${base}` });

      const jobs = await client.listJobs();
      expect(jobs.map((j) => j.id)).toEqual(["j1", "j2"]);

      const submitted = await client.submitFromSpec('{"name":"new"}');
      expect(submitted).toEqual({ id: "j3", name: "new" });
      expect((await client.listJobs()).map((j) => j.id)).toEqual(["j1", "j2", "j3"]);

      const detail = await client.getJobDetail("j1");
      expect(detail).toMatchObject({ id: "j1", name: "wrf", node: "node01" });

      await client.cancelJob("j2");
      expect((await client.listJobs()).map((j) => j.id)).toEqual(["j1", "j3"]);

      // A Server-only method round-trips as 501 → UnsupportedInModeError on the client.
      await expect(client.listWorkflows()).rejects.toBeInstanceOf(UnsupportedInModeError);
    } finally {
      server.stop(true);
    }
  });

  test("served agent reporting metrics round-trips listAgents (metrics pane path)", async () => {
    const localNode: TuiAgent = {
      id: "local",
      site: "this-node",
      scheduler: "slurm",
      status: "running",
      cpuPercent: 12,
      memoryUsedMb: 2048,
      memoryTotalMb: 8192,
    };
    const metricsBackend: TuiBackend = {
      ...fakeBackend(),
      capabilities: { ...CAPS, metrics: true },
      async listAgents() {
        return [localNode];
      },
    };
    const server = Bun.serve({
      port: 0,
      fetch: createAgentServer(metricsBackend, { token: "t" }).fetch,
    });
    try {
      const base = `http://localhost:${server.port}`;
      const client = await ExternalAgentBackend.create(base, { token: "t" });

      expect(client.capabilities.metrics).toBe(true);
      // The metrics pane drives backend.listAgents(); it must round-trip the row.
      expect(await client.listAgents()).toEqual([localNode]);
    } finally {
      server.stop(true);
    }
  });

  test("wrong token → 401 plain Error (not UnsupportedInModeError)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: createAgentServer(fakeBackend(), { token: "right" }).fetch,
    });
    try {
      const base = `http://localhost:${server.port}`;
      // create() itself hits /capabilities, so a wrong token fails at construction.
      await expect(ExternalAgentBackend.create(base, { token: "wrong" })).rejects.toThrow(/401/);
    } finally {
      server.stop(true);
    }
  });
});
