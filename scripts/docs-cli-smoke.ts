#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryDirectory = resolve(import.meta.dir, "..");
const specPath = resolve(
  process.argv[2] ?? join(repositoryDirectory, "docs/manuals/examples/job-smoke.json"),
);
const cliEntry = resolve(repositoryDirectory, "packages/cli/src/index.ts");
const jobId = "00000000-0000-4000-8000-000000000044";
const expectedToken = "docs-cli-smoke-token";

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function fail(message: string): never {
  throw new Error(`CLI smoke 失败：${message}`);
}

async function runCli(args: string[], configPath: string): Promise<RunResult> {
  const child = Bun.spawn(["bun", cliEntry, ...args], {
    cwd: repositoryDirectory,
    env: { ...process.env, KQ_CONFIG_FILE: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const spec = await Bun.file(specPath).json();
if (
  !spec ||
  typeof spec !== "object" ||
  typeof spec.name !== "string" ||
  typeof spec.command !== "string"
) {
  fail(`spec 不可读或缺少 name/command：${specPath}`);
}

let submittedBody: Record<string, unknown> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "missing smoke token" } },
        { status: 401 },
      );
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      submittedBody = (await request.json()) as Record<string, unknown>;
      return Response.json(
        {
          id: jobId,
          name: submittedBody.name,
          status: "queued",
        },
        { status: 201 },
      );
    }
    if (request.method === "GET" && url.pathname === `/api/jobs/${jobId}`) {
      return Response.json({ id: jobId, name: spec.name, status: "queued" });
    }
    if (request.method === "GET" && url.pathname === `/api/jobs/${jobId}/logs`) {
      return Response.json({ text: "kuintessence-cli-smoke\n" });
    }
    return Response.json(
      { error: { code: "NOT_FOUND", message: "smoke route not found" } },
      { status: 404 },
    );
  },
});

const temporaryDirectory = mkdtempSync(join(tmpdir(), "kq-docs-cli-smoke-"));
const configPath = join(temporaryDirectory, "config.json");
await Bun.write(
  configPath,
  JSON.stringify({ serverUrl: `http://${server.hostname}:${server.port}`, token: expectedToken }),
);

try {
  const submit = await runCli(["submit", specPath], configPath);
  if (submit.exitCode !== 0 || !new RegExp(`Job submitted: ${jobId}`).test(submit.stdout)) {
    fail(`submit 未返回唯一 Job ID；stdout=${submit.stdout.trim()} stderr=${submit.stderr.trim()}`);
  }
  if (submittedBody?.name !== spec.name || submittedBody?.command !== spec.command) {
    fail("submit 没有把 JSON spec 原样发送给 Server");
  }

  const status = await runCli(["status", jobId], configPath);
  if (
    status.exitCode !== 0 ||
    !status.stdout.includes(`Job: ${spec.name} (${jobId})`) ||
    !status.stdout.includes("Status: queued")
  ) {
    fail(`status 未读取预期 Job；stdout=${status.stdout.trim()} stderr=${status.stderr.trim()}`);
  }

  const logs = await runCli(["logs", jobId], configPath);
  if (logs.exitCode !== 0 || logs.stdout.trim() !== "kuintessence-cli-smoke") {
    fail(`logs 未读取预期输出；stdout=${logs.stdout.trim()} stderr=${logs.stderr.trim()}`);
  }

  const invalid = await runCli(
    ["submit", "--agent", "scheduler-slurm", "--command", "hostname"],
    configPath,
  );
  const invalidOutput = `${invalid.stdout}\n${invalid.stderr}`;
  if (invalid.exitCode === 0 || !/unknown option|unknown command/i.test(invalidOutput)) {
    fail("旧的 --agent/--command 写法没有按预期失败");
  }

  console.log(`PASS: 真实 CLI submit/status/logs smoke；Job ID ${jobId}；旧选项失败分支已确认。`);
} finally {
  server.stop();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
