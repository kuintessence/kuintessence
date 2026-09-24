import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const flag = "--spack-file-workflow-samtools";
const overlayPath = "deploy/compose/docker-compose.pr-spack-file-workflow.yml";
const workflowPath = ".github/workflows/spack-workflow-execution.yml";

interface Service {
  image?: string;
  command?: string[];
  entrypoint?: string[];
  environment?: Record<string, string>;
  networks?: string[];
  network_mode?: string;
  ports?: unknown;
  volumes?: unknown[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
  restart?: string;
}

interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { internal: boolean }>;
  volumes?: Record<string, unknown>;
}

interface Workflow {
  on: { pull_request: { paths: string[] } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      "timeout-minutes"?: number;
      strategy?: {
        "fail-fast": boolean;
        matrix: { include: { case: string; flag: string }[] };
      };
      steps: {
        id?: string;
        uses?: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The runner executes only these stubs; Docker never contacts a daemon.
const fakeDocker = `#!/bin/bash
set -euo pipefail
printf 'docker %s | file=%s case=%s\\n' "$*" \
  "\${KQ_PR_SPACK_FILE_WORKFLOW-unset}" "\${KQ_PR_SPACK_CASE-unset}" >> "$FILE_TRACE"
if [[ " $* " == *" -p "* ]]; then
  if [[ "\${KQ_PR_SPACK_FILE_WORKFLOW-unset}" == 1 ]]; then
    [[ "$KQ_PR_RUSTFS_ACCESS_KEY" =~ ^[a-f0-9]{32}$ ]]
    [[ "$KQ_PR_RUSTFS_SECRET_KEY" =~ ^[a-f0-9]{64}$ ]]
    [[ "$KQ_PR_NETDRIVE_SECRET_KEY" =~ ^[a-f0-9]{64}$ ]]
    [[ "$KQ_PR_RUSTFS_SECRET_KEY" != "$KQ_PR_NETDRIVE_SECRET_KEY" ]]
  else
    [[ -z "\${KQ_PR_RUSTFS_ACCESS_KEY+x}" ]]
    [[ -z "\${KQ_PR_RUSTFS_SECRET_KEY+x}" ]]
    [[ -z "\${KQ_PR_NETDRIVE_SECRET_KEY+x}" ]]
  fi
fi
case " $* " in
  *" up -d --no-build --wait --wait-timeout 300 server registry "*)
    [[ "$FILE_FAIL" != storage-start ]] || exit 21 ;;
  *" bun deploy/pr-test/spack-managed/workflow-assets.ts "*)
    [[ "$FILE_FAIL" != workflow-assets ]] || exit 22 ;;
  *" bun deploy/pr-test/spack-managed/file-workflow-assets.ts "*)
    [[ "$FILE_FAIL" != file-assets ]] || exit 23 ;;
  *" restart rustfs "*)
    [[ "$FILE_FAIL" != storage-restart ]] || exit 24 ;;
  *" up -d --no-deps --no-build --wait --wait-timeout 300 rustfs "*)
    [[ "$FILE_FAIL" != storage-ready ]] || exit 25 ;;
  *" up -d --no-deps --no-build --wait --wait-timeout 300 registry server "*)
    [[ "$FILE_FAIL" != server-ready ]] || exit 26 ;;
  *"spack-case/rollout.ts activate "*)
    printf '12345678-abcd-4123-8123-123456789abc\\n' ;;
  *" down "*) [[ "$FILE_FAIL" != cleanup ]] || exit 27 ;;
  *" logs "*) printf 'private-storage-error\\n' >&2; exit 28 ;;
esac
if [[ "\${1:-}" == cp ]]; then
  mkdir -p "$3"
  printf 'fixture\\n' > "$3/checksums.txt"
fi
`;

async function runRunner(args: string[], failure = "none", githubActions = "true") {
  const directory = await mkdtemp(join(tmpdir(), "kq-file-workflow-test-"));
  temporary.push(directory);
  const tools = join(directory, "tools");
  const runnerTemp = join(directory, "runner-temp");
  await Promise.all([mkdir(tools), mkdir(runnerTemp)]);
  await writeFile(join(tools, "docker"), fakeDocker, { mode: 0o755 });
  await writeFile(
    join(tools, "sha256sum"),
    `#!/bin/bash
set -euo pipefail
[[ "$*" == "--strict --check checksums.txt" && -f checksums.txt ]]
`,
    { mode: 0o755 },
  );
  const trace = join(directory, "trace");
  const child = Bun.spawn({
    cmd: ["bash", join(root, "deploy/pr-test/run.sh"), ...args],
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      FILE_TRACE: trace,
      FILE_FAIL: failure,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ACTIONS: githubActions,
      COMPOSE_FILE: "inherited-must-not-use",
      COMPOSE_ENV_FILES: "inherited-must-not-use",
      COMPOSE_PROJECT_NAME: "inherited-must-not-use",
      KQ_PR_SPACK_FILE_WORKFLOW: "1",
      KQ_PR_RUSTFS_ACCESS_KEY: "inherited-must-not-use",
      KQ_PR_RUSTFS_SECRET_KEY: "inherited-must-not-use",
      KQ_PR_NETDRIVE_SECRET_KEY: "inherited-must-not-use",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const commands = await readFile(trace, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  expect(await readdir(runnerTemp)).toEqual([]);
  return { code, stdout, stderr, commands };
}

function inOrder(commands: string, stages: string[]) {
  let previous = -1;
  for (const stage of stages) {
    const next = commands.indexOf(stage, previous + 1);
    expect({ stage, found: next > previous }).toEqual({ stage, found: true });
    previous = next;
  }
}

describe("file workflow runner with fake tools", () => {
  test("requires Actions, Slurm and the exact single flag", async () => {
    const rejected: [string[], string][] = [
      [["slurm", flag], "false"],
      [["pbs", flag], "true"],
      [["slurm", flag, "--config"], "true"],
      [["slurm", "--spack-file-workflow-hello"], "true"],
    ];
    for (const [args, actions] of rejected) {
      const result = await runRunner(args, "none", actions);
      expect(result.code).toBe(2);
      expect(result.commands).toBe("");
    }
  });

  test("registers before Agent start and restarts storage without replaying bootstrap", async () => {
    const result = await runRunner(["slurm", flag]);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("file=1 case=samtools");
    expect(result.commands).not.toMatch(/inherited-must-not-use|\blogs\b|\bprune\b/);
    const config = result.commands.split("\n").find((line) => line.includes("config --quiet"));
    expect(config).toBeDefined();
    inOrder(config ?? "", [
      "docker-compose.pr-test.yml",
      "docker-compose.pr-spack-case.yml",
      "docker-compose.pr-spack-managed.yml",
      "docker-compose.pr-spack-artifact-managed.yml",
      "docker-compose.pr-spack-workflow.yml",
      "docker-compose.pr-spack-file-workflow.yml",
    ]);
    inOrder(result.commands, [
      "spack-case/setup.ts",
      "300 server registry",
      "managed-handoff.ts prepare",
      "managed-handoff.ts verify",
      "artifact-control bun deploy/pr-test/spack-managed/workflow-assets.ts",
      "artifact-control bun deploy/pr-test/spack-managed/file-workflow-assets.ts",
      "300 scheduler registry",
      "2400s bun deploy/pr-test/spack-managed/case.ts install",
      "stop scheduler server",
      "restart rustfs",
      "up -d --no-deps --no-build --wait --wait-timeout 300 rustfs",
      "restart registry server",
      "up -d --no-deps --no-build --wait --wait-timeout 300 registry server",
      "up -d --no-deps --no-build --wait --wait-timeout 300 scheduler",
      "references.ts managed-restart",
      "managed-handoff.ts verify",
      "2100s bun deploy/pr-test/spack-managed/case.ts restart",
      "300s bun deploy/pr-test/spack-managed/case.ts uninstall",
      "rollout.ts activate",
      "rollout.ts verify",
      "down --volumes --remove-orphans --rmi local",
    ]);
    const restart = result.commands.slice(
      result.commands.indexOf("stop scheduler server"),
      result.commands.indexOf("references.ts managed-restart"),
    );
    expect(restart).not.toMatch(/rustfs-init|force-recreate|--renew-anon-volumes/);
    expect(
      result.commands.match(/bun deploy\/pr-test\/spack-managed\/file-workflow-assets.ts/g),
    ).toHaveLength(1);
    expect(result.stdout.match(/^::add-mask::/gm)).toHaveLength(6);
    const publicOutput = result.stdout.replace(/^::add-mask::.*$/gm, "");
    expect(`${publicOutput}${result.stderr}${result.commands}`).not.toMatch(/\b[a-f0-9]{64}\b/);
    expect(result.stdout).toContain("stage=cleanup code=OK");
  });

  test.each(["storage-start", "workflow-assets", "file-assets"])(
    "%s failure blocks Agent startup and removes disposable volumes",
    async (failure) => {
      const result = await runRunner(["slurm", flag], failure);
      expect(result.code).not.toBe(0);
      expect(result.commands).not.toContain("300 scheduler registry");
      expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
      expect(result.commands).not.toMatch(/\blogs\b|\bprune\b/);
      expect(`${result.stdout}${result.stderr}`).not.toContain("private-storage-error");
      expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    },
  );

  test.each(["storage-restart", "storage-ready", "server-ready"])(
    "%s failure blocks restart acceptance",
    async (failure) => {
      const result = await runRunner(["slurm", flag], failure);
      expect(result.code).not.toBe(0);
      expect(result.commands).toContain("spack-managed/case.ts install");
      expect(result.commands).not.toContain("spack-managed/case.ts restart");
      expect(result.commands).not.toContain("spack-managed/case.ts uninstall");
      expect(result.commands).not.toContain("rollout.ts");
      expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
      expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    },
  );

  test("cleanup failure cannot report success", async () => {
    const result = await runRunner(["slurm", flag], "cleanup");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("stage=cleanup code=OK");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
  });

  test.each(["--config", "--spack-workflow-hello", "--spack-workflow-samtools"])(
    "%s ignores ambient file mode and keeps the old timeouts",
    async (legacyFlag) => {
      const result = await runRunner(["slurm", legacyFlag]);
      expect(result.code).toBe(0);
      expect(result.commands).not.toContain("file=1");
      expect(result.commands).not.toContain("pr-spack-file-workflow.yml");
      expect(result.commands).not.toContain("file-workflow-assets.ts");
      expect(result.commands).not.toContain("restart rustfs");
      expect(result.stdout.match(/^::add-mask::/gm)).toHaveLength(3);
      if (legacyFlag === "--config") {
        expect(result.commands).not.toMatch(/\b(info|build|up|exec|down)\b/);
      } else {
        expect(result.commands).toContain("1500s bun deploy/pr-test/spack-managed/case.ts install");
        expect(result.commands).toContain("900s bun deploy/pr-test/spack-managed/case.ts restart");
        expect(result.commands).toContain("180s bun deploy/pr-test/spack-managed/case.ts uninstall");
        expect(result.commands).toContain("restart registry scheduler server");
      }
    },
  );
});

describe("file workflow deployment contracts", () => {
  test("uses Agent-managed work roots only in file mode without extra privileged setup", async () => {
    const base = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-test.yml"), "utf8"),
    ) as Compose;
    const overlay = parse(await readFile(join(root, overlayPath), "utf8")) as Compose;
    expect(base.services.server?.environment?.WORKFLOW_RUN_BASE).toBe(
      "/scratch/kuintessence-workflows",
    );
    expect(overlay.services.server?.environment?.WORKFLOW_RUN_BASE).toBe("");
    expect(overlay.services.scheduler?.environment?.AGENT_JOB_WORK_ROOT).toBeUndefined();
    expect(overlay.services.scheduler?.entrypoint).toBeUndefined();
    expect(overlay.services.scheduler?.command).toBeUndefined();
    const config = await readFile(join(root, "packages/agent/src/config.ts"), "utf8");
    expect(config).toMatch(
      /AGENT_JOB_WORK_ROOT: dedicatedAbsolutePath\("AGENT_JOB_WORK_ROOT"\)\.default\(\s*"\/var\/lib\/kuintessence\/jobs"/,
    );
    const start = await readFile(join(root, "deploy/pr-test/spack-managed/start.sh"), "utf8");
    inOrder(start, ["chown -R kq:kq /var/lib/kuintessence", "exec runuser -u kq"]);
    const roots = await readFile(
      join(root, "packages/agent/src/data-market/local-data-security.ts"),
      "utf8",
    );
    expect(roots).toContain("ensurePrivateDirectory(this.options.jobWorkRoot)");
    expect(roots).toContain("mkdir(path, { recursive: true, mode: 0o700 })");
  });

  test("isolates storage and scopes root and committer credentials", async () => {
    const overlay = parse(await readFile(join(root, overlayPath), "utf8")) as Compose;
    expect(overlay.networks).toEqual({ "file-workflow-storage": { internal: true } });
    expect(Object.keys(overlay.volumes ?? {})).toEqual(["file-workflow-storage"]);
    expect(overlay.services.registry).toBeUndefined();
    for (const service of Object.values(overlay.services)) {
      expect(service.ports).toBeUndefined();
      expect(service.network_mode).toBeUndefined();
      expect(service.networks).toEqual(["file-workflow-storage"]);
    }
    const storage = overlay.services.rustfs;
    expect(storage?.image).toBe("rustfs/rustfs:1.0.0");
    expect(storage?.command).toEqual(["rustfs", "/data"]);
    expect(storage?.volumes).toEqual(["file-workflow-storage:/data"]);
    expect(storage?.environment).toEqual({
      RUSTFS_ACCESS_KEY: "${KQ_PR_RUSTFS_ACCESS_KEY:?required}",
      RUSTFS_SECRET_KEY: "${KQ_PR_RUSTFS_SECRET_KEY:?required}",
      RUSTFS_CONSOLE_ENABLE: "false",
    });
    expect(storage?.healthcheck?.test).toEqual([
      "CMD",
      "curl",
      "-fsS",
      "http://127.0.0.1:9000/health",
    ]);
    const init = overlay.services["rustfs-init"];
    expect(init?.image).toBe("rustfs/rc:v0.1.36");
    expect(init?.entrypoint).toEqual(["sh", "/bootstrap-object-lock.sh"]);
    expect(init?.restart).toBe("no");
    expect(init?.depends_on).toEqual({ rustfs: { condition: "service_healthy" } });
    expect(init?.volumes).toEqual([
      {
        type: "bind",
        source: "./deploy/rustfs/bootstrap-object-lock.sh",
        target: "/bootstrap-object-lock.sh",
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    const server = overlay.services.server;
    expect(server?.depends_on).toEqual({
      "rustfs-init": { condition: "service_completed_successfully" },
    });
    expect(server?.environment).toMatchObject({
      NETDRIVE_ENABLED: "true",
      NETDRIVE_ENDPOINT: "rustfs",
      NETDRIVE_PORT: "9000",
      NETDRIVE_USE_SSL: "false",
      NETDRIVE_REGION: "us-east-1",
      NETDRIVE_PUBLIC_URL: "http://rustfs:9000",
      NETDRIVE_ACCESS_KEY: "kq-data-market-committer",
      NETDRIVE_SECRET_KEY: "${KQ_PR_NETDRIVE_SECRET_KEY:?required}",
    });
    for (const key of [
      "NETDRIVE_BUCKET",
      "DATA_MARKET_STAGING_BUCKET",
      "DATA_MARKET_IMMUTABLE_BUCKET",
      "DATA_MARKET_IMMUTABLE_RETENTION_DAYS",
      "DATA_MARKET_COMMITTER_ACCESS_KEY",
    ]) {
      expect(server?.environment?.[key]).toBeDefined();
      expect(server?.environment?.[key]).toBe(init?.environment?.[key]);
    }
    expect(init?.environment?.DATA_MARKET_COMMITTER_SECRET_KEY).toBe(
      server?.environment?.NETDRIVE_SECRET_KEY,
    );
    expect(server?.environment?.RUSTFS_ACCESS_KEY).toBeUndefined();
    expect(server?.environment?.RUSTFS_SECRET_KEY).toBeUndefined();
    for (const name of ["case-operator", "artifact-control", "scheduler"]) {
      const service = overlay.services[name];
      expect(service?.environment?.KQ_PR_SPACK_FILE_WORKFLOW).toBe("1");
      expect(
        Object.keys(service?.environment ?? {}).some((key) => /SECRET|ACCESS_KEY/.test(key)),
      ).toBe(false);
      expect(service?.volumes).toBeUndefined();
    }
    expect(overlay.services.scheduler?.environment?.AGENT_FILE_TRANSFER_CONNECT_TO).toBe("");
    expect(overlay.services.scheduler?.environment?.AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO).toBe(
      "",
    );
    const environment = await readFile(
      join(root, "deploy/pr-test/spack-managed/environment.ts"),
      "utf8",
    );
    expect(environment).toContain('"KQ_PR_SPACK_FILE_WORKFLOW"');
    expect(environment).toContain('"AGENT_FILE_TRANSFER_CONNECT_TO"');
    expect(environment).toContain('"AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO"');
    expect(environment).not.toMatch(/RUSTFS|NETDRIVE_SECRET_KEY/);
  });

  test("preserves old matrix entries and adds bounded file acceptance and contracts", async () => {
    const workflow = parse(await readFile(join(root, workflowPath), "utf8")) as Workflow;
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.pull_request.paths).toContain(overlayPath);
    expect(workflow.on.pull_request.paths).toContain("deploy/rustfs/**");
    expect(workflow.on.pull_request.paths).toContain("scripts/spack-file-workflow.test.ts");
    const managed = workflow.jobs["managed-workflow"];
    expect(managed?.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(managed?.["timeout-minutes"]).toBe(85);
    expect(managed?.strategy?.["fail-fast"]).toBe(false);
    expect(managed?.strategy?.matrix.include).toEqual([
      { case: "hello", flag: "--spack-workflow-hello" },
      { case: "samtools", flag: "--spack-workflow-samtools" },
      { case: "samtools-file", flag },
    ]);
    const execution = managed?.steps.find((step) =>
      step.run?.includes("bash deploy/pr-test/run.sh"),
    );
    expect(execution?.env).toEqual({ CASE_FLAG: "${{ matrix.flag }}" });
    expect(execution?.run).toContain("timeout --signal=TERM --kill-after=60s 80m");
    expect(execution?.run).toContain('bash deploy/pr-test/run.sh slurm "$CASE_FLAG"');
    expect(
      managed?.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ).toBe(false);
    const contracts = workflow.jobs.contracts?.steps.map((step) => step.run ?? "").join("\n");
    expect(contracts).toContain("scripts/spack-file-workflow.test.ts");
    expect(contracts).toContain("deploy/pr-test/spack-managed/file-workflow*.test.ts");
    expect(contracts).toContain("deploy/pr-test/spack-managed/workflow-assets.test.ts");
    const tsconfig = JSON.parse(
      await readFile(join(root, "deploy/pr-test/tsconfig.json"), "utf8"),
    ) as { include: string[] };
    expect(tsconfig.include).toContain("../../scripts/spack-file-workflow.test.ts");
  });
});
