import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { type Stack, startStack } from "./fixtures/stack";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

let stack: Stack;
let cliConfigDir: string;
let cliConfigFile: string;

beforeAll(async () => {
  stack = await startStack();
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-cli-e2e-"));
  cliConfigFile = join(cliConfigDir, "config.json");
  writeFileSync(
    cliConfigFile,
    JSON.stringify({ serverUrl: stack.serverBaseUrl, token: stack.adminToken }),
  );
}, 240_000);

afterAll(async () => {
  if (cliConfigDir) rmSync(cliConfigDir, { recursive: true, force: true });
  await stack?.stop();
});

describe("e2e: CLI → Server → Agent → real Slurm", () => {
  test("submit echo job and observe completed within 90s", async () => {
    // 1. Run CLI submit
    const submitProc = spawn(
      [
        "bun",
        "run",
        join(REPO_ROOT, "packages/cli/src/index.ts"),
        "submit",
        join(REPO_ROOT, "test/e2e/fixtures/job.sample.json"),
      ],
      {
        env: { ...process.env, KQ_CONFIG_FILE: cliConfigFile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [submitStdout, submitStderr, submitExit] = await Promise.all([
      new Response(submitProc.stdout).text(),
      new Response(submitProc.stderr).text(),
      submitProc.exited,
    ]);
    if (submitExit !== 0) {
      throw new Error(
        `kq submit exit=${submitExit}\nstdout:\n${submitStdout}\nstderr:\n${submitStderr}`,
      );
    }
    const idMatch = submitStdout.match(/Job submitted: ([0-9a-f-]{36})/);
    if (!idMatch) {
      throw new Error(`kq submit stdout missing Job UUID:\n${submitStdout}`);
    }
    const jobId = idMatch[1];

    // 2. Poll /api/jobs/:id until terminal
    const final = await pollJob(stack.serverBaseUrl, stack.adminToken, jobId, 90_000);
    // Include the full job body in the error so CI logs surface the actual status
    // and schedulerJobId without having to re-run the test interactively.
    if (final.status !== "completed") {
      throw new Error(`Expected status=completed, got ${JSON.stringify(final)}`);
    }
    expect(final.status).toBe("completed");
    expect(final.schedulerJobId).toMatch(/^\d+$/);
    expect(final.startedAt).not.toBeNull();
    expect(final.completedAt).not.toBeNull();
    if (final.startedAt && final.completedAt) {
      expect(new Date(final.completedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(final.startedAt).getTime(),
      );
    }
  }, 180_000);
});

interface JobView {
  id: string;
  status: string;
  schedulerJobId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

async function pollJob(
  base: string,
  token: string,
  id: string,
  timeoutMs: number,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: unknown = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/api/jobs/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const j = (await r.json()) as JobView;
      lastBody = j;
      if (j.status === "completed" || j.status === "failed") return j;
    }
    await Bun.sleep(2000);
  }
  throw new Error(
    `Job ${id} did not terminate in ${timeoutMs}ms; last body: ${JSON.stringify(lastBody)}`,
  );
}
