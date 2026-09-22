import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const flags = ["--spack-artifact-hello", "--spack-artifact-samtools"];

interface Service {
  image?: string;
  build?: {
    dockerfile: string;
    args?: Record<string, string>;
    additional_contexts?: Record<string, string>;
  };
  environment?: Record<string, string>;
  networks?: string[];
  network_mode?: string;
  ports?: unknown;
  volumes?: unknown[];
}

interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { internal: boolean }>;
  volumes?: Record<string, unknown>;
}

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: Record<string, string>;
      strategy?: { "fail-fast": boolean; matrix: { include?: { flag: string }[] } };
      steps?: Step[];
    }
  >;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fakeDocker = `#!/bin/bash
set -euo pipefail
printf 'docker %s | case=%s artifact=%s epoch=%s apt=%s recipe=%s material=%s result=%s ambient=%s/%s/%s\\n' \
  "$*" "\${KQ_PR_SPACK_CASE-unset}" "\${KQ_ARTIFACT_DIRECTORY-unset}" \
  "\${KQ_PR_MATERIAL_EPOCH-unset}" "\${KQ_PR_APT_MIRROR-unset}" \
  "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP-unset}" "\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP-unset}" \
  "\${KQ_ARTIFACT_RESULT_PATH-unset}" "\${COMPOSE_FILE-unset}" \
  "\${COMPOSE_PROFILES-unset}" "\${COMPOSE_ENV_FILES-unset}" >> "$MANAGED_TRACE"
case " $* " in
  *" config --quiet "*) [[ "$MANAGED_FAIL" != config ]] || exit 11 ;;
  *" info "*) [[ "$MANAGED_FAIL" != info ]] || exit 12 ;;
  *" build scheduler "*) [[ "$MANAGED_FAIL" != build ]] || exit 19 ;;
  *" build artifact-exporter managed-builder "*)
    [[ "$MANAGED_FAIL" != material-build ]] || exit 20 ;;
  *" deploy/pr-test/spack-artifacts/export.ts "*)
    (
      while [[ "$1" != --entrypoint ]]; do shift; done
      [[ "$2" == bash && "$3" == artifact-exporter && "$4" == -euc ]]
      [[ "$5" == $'mkdir -m 0755 /out\\nexec bun deploy/pr-test/spack-artifacts/export.ts "$@"' ]]
      shift 5
      [[ $# == 6 && "$1" == export && "$2" == /opt/kq-case && "$3" == /out/delivery ]]
      [[ "$4" == "$KQ_PR_SPACK_CASE" ]]
      [[ "$5" == "public/pr-$4-recipes" && "$6" == "public/pr-$4-sources" ]]
    )
    [[ "$MANAGED_FAIL" != export ]] || exit 23 ;;
  *"deploy/pr-test/spack-case/setup.ts "*) [[ "$MANAGED_FAIL" != setup ]] || exit 24 ;;
  *" up "*)
    [[ "$MANAGED_FAIL" != up ]] || exit 25
    if [[ "$MANAGED_FAIL" == recreate && " $* " == *" --force-recreate "* ]]; then exit 33; fi ;;
  *"deploy/pr-test/spack-artifacts/managed-handoff.ts prepare "*)
    [[ "$MANAGED_FAIL" != prepare ]] || exit 26 ;;
  *"deploy/pr-test/spack-artifacts/managed-handoff.ts verify "*)
    [[ "$MANAGED_FAIL" != verify ]] || exit 27
    count="$(grep -c 'managed-handoff.ts verify ' "$MANAGED_TRACE")"
    if [[ "$MANAGED_FAIL" == verify-restart && "$count" == 2 ]]; then exit 34; fi ;;
  *"deploy/pr-test/spack-managed/case.ts install "*) [[ "$MANAGED_FAIL" != install ]] || exit 28 ;;
  *"deploy/pr-test/spack-case/rollout.ts activate "*)
    [[ "$MANAGED_FAIL" != rollout ]] || exit 29
    printf '12345678-abcd-4123-8123-123456789abc\\n' ;;
  *" down "*) [[ "$MANAGED_FAIL" != cleanup ]] || exit 30 ;;
  *" image rm "*) [[ "$MANAGED_FAIL" != cleanup-images ]] || exit 35 ;;
  *" logs "*) printf 'private-container-token\\n'; printf 'private-container-error\\n' >&2 ;;
esac
if [[ "\${1:-}" == cp ]]; then
  mkdir -p "$3"
  printf 'fixture\\n' > "$3/checksums.txt"
  [[ "$MANAGED_FAIL" != copy ]] || exit 31
fi
`;

const fakeChecksum = `#!/bin/bash
set -euo pipefail
[[ "$*" == "--strict --check checksums.txt" && -f checksums.txt ]]
printf 'checksum %s | cwd=%s\\n' "$*" "$PWD" >> "$MANAGED_TRACE"
count="$(grep -c '^checksum ' "$MANAGED_TRACE")"
if [[ "$MANAGED_FAIL" == checksum-initial && "$count" == 1 ]] ||
   [[ "$MANAGED_FAIL" == checksum-final && "$count" == 2 ]]; then
  printf 'private-checksum-error\\n' >&2
  exit 32
fi
`;

async function runRunner(
  args: string[],
  options: {
    failure?: string;
    githubActions?: string;
    runnerTemp?: "valid" | "missing" | "relative" | "absent";
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "kq-artifact-managed-test-"));
  temporary.push(directory);
  const tools = join(directory, "tools");
  const runnerTemp = join(directory, "runner-temp");
  const inherited = join(directory, "inherited-delivery");
  await Promise.all([mkdir(tools), mkdir(runnerTemp), mkdir(inherited)]);
  await writeFile(join(inherited, "keep"), "untouched");
  await writeFile(join(tools, "docker"), fakeDocker, { mode: 0o755 });
  await writeFile(join(tools, "sha256sum"), fakeChecksum, { mode: 0o755 });
  const log = join(directory, "commands");
  const paths = { valid: runnerTemp, missing: "", relative: "relative", absent: `${directory}/no` };
  const child = Bun.spawn({
    cmd: ["bash", join(root, "deploy/pr-test/run.sh"), ...args],
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      MANAGED_TRACE: log,
      MANAGED_FAIL: options.failure ?? "none",
      RUNNER_TEMP: paths[options.runnerTemp ?? "valid"],
      GITHUB_ACTIONS: options.githubActions ?? "true",
      COMPOSE_PROJECT_NAME: "production-must-not-touch",
      COMPOSE_FILE: "inherited-must-not-use",
      COMPOSE_PROFILES: "inherited-must-not-use",
      COMPOSE_ENV_FILES: "inherited-must-not-use",
      KQ_PR_MATERIAL_EPOCH: "inherited-must-not-use",
      KQ_PR_SPACK_CASE: "inherited-must-not-use",
      KQ_PR_APT_MIRROR: "inherited-must-not-use",
      KQ_ARTIFACT_DIRECTORY: inherited,
      KQ_ARTIFACT_RECIPE_BOOTSTRAP: "inherited-must-not-use",
      KQ_ARTIFACT_MATERIAL_BOOTSTRAP: "inherited-must-not-use",
      KQ_ARTIFACT_RESULT_PATH: "inherited-must-not-use",
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
  const commands = await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  expect(await readFile(join(inherited, "keep"), "utf8")).toBe("untouched");
  return { code, stdout, stderr, commands, remaining: await readdir(runnerTemp), runnerTemp };
}

function before(commands: string, first: string, second: string) {
  const start = commands.indexOf(first);
  const end = commands.indexOf(second, start + first.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
}

describe("managed artifact runner with fake tools only", () => {
  test.each(flags)("rejects %s outside Actions and outside Slurm", async (flag) => {
    const rejected: [string[], string][] = [
      [["slurm", flag], "false"],
      [["slurm", flag], "TRUE"],
      [["pbs", flag], "true"],
      [["slurm", flag, "--config"], "true"],
    ];
    for (const [args, githubActions] of rejected) {
      const result = await runRunner(args, { githubActions });
      expect(result.code).toBe(2);
      expect(result.commands).toBe("");
      expect(result.remaining).toEqual([]);
    }
  });

  test("rejects unknown flags and invalid Actions temporary directories", async () => {
    const unknown = await runRunner(["slurm", "--spack-artifact-other"]);
    expect(unknown.code).toBe(2);
    expect(unknown.commands).toBe("");
    for (const runnerTemp of ["missing", "relative", "absent"] as const) {
      const result = await runRunner(["slurm", "--spack-artifact-hello"], { runnerTemp });
      expect(result.code).toBe(2);
      expect(result.commands).toBe("");
      expect(result.remaining).toEqual([]);
    }
  });

  test.each(flags)("%s preserves export, handoff and managed ordering", async (flag) => {
    const result = await runRunner(["slurm", flag]);
    expect(result.code).toBe(0);
    expect(result.remaining).toEqual([]);
    expect(result.commands).not.toContain("inherited-must-not-use");
    expect(result.commands).not.toContain("production-must-not-touch");
    expect(result.commands).not.toMatch(/case-operator|case-native|publish\.ts|export-lock\.ts/);
    expect(result.commands).not.toMatch(/\b(logs|prune|port)\b/);
    const selected = flag === "--spack-artifact-hello" ? "hello" : "samtools";
    expect(result.commands).toContain(
      `export /opt/kq-case /out/delivery ${selected} public/pr-${selected}-recipes public/pr-${selected}-sources`,
    );
    expect(result.commands.match(/deploy\/pr-test\/spack-artifacts\/export\.ts/g)).toHaveLength(1);
    expect(result.commands).toContain(`case=${selected}`);
    expect(result.commands).toContain(`artifact=${result.runnerTemp}/kq-spack-managed.`);
    expect(result.commands).toContain("apt=unset");
    expect(result.commands).toContain("result=unset");
    expect(result.commands).toContain("ambient=unset/unset/unset");
    const overlays = ["pr-test", "pr-spack-case", "pr-spack-managed", "pr-spack-artifact-managed"];
    for (const overlay of overlays) {
      expect(result.commands).toContain(`docker-compose.${overlay}.yml`);
    }
    const configuration =
      result.commands.split("\n").find((line) => line.includes("config --quiet")) ?? "";
    before(configuration, "docker-compose.pr-test.yml", "docker-compose.pr-spack-case.yml");
    before(
      configuration,
      "docker-compose.pr-spack-case.yml",
      "docker-compose.pr-spack-managed.yml",
    );
    before(
      configuration,
      "docker-compose.pr-spack-managed.yml",
      "docker-compose.pr-spack-artifact-managed.yml",
    );
    before(result.commands, "build scheduler", "build artifact-exporter managed-builder");
    before(result.commands, "0444 /runtime/spack.sif", "deploy/pr-test/spack-artifacts/export.ts");
    before(result.commands, "docker cp ", "checksum --strict --check");
    before(
      result.commands,
      "checksum --strict --check",
      "artifact-control bun deploy/pr-test/spack-case/setup.ts",
    );
    before(
      result.commands,
      "spack-case/setup.ts",
      "up -d --no-build --wait --wait-timeout 300 server registry",
    );
    before(result.commands, "300 server registry", "managed-handoff.ts prepare");
    before(result.commands, "managed-handoff.ts prepare", "300 registry server");
    before(result.commands, "300 registry server", "managed-handoff.ts verify");
    before(result.commands, "managed-handoff.ts verify", "300 scheduler registry");
    expect(result.commands).not.toContain("restart server |");
    const prepare = result.commands
      .split("\n")
      .find((line) => line.includes("managed-handoff.ts prepare"));
    expect(prepare).toContain("recipe=/imports/delivery/recipe-pack/manifest.json");
    expect(prepare).toContain("material=/imports/delivery/material-pack/manifest.json");
    const afterPrepare = result.commands
      .slice(result.commands.indexOf("managed-handoff.ts prepare"))
      .split("\n")
      .slice(1);
    for (const command of afterPrepare.filter((line) => line.startsWith("docker "))) {
      expect(command).toContain("recipe=unset material=unset");
    }
    expect(result.commands).toContain(
      "up -d --force-recreate --no-build --wait --wait-timeout 300 registry server",
    );
    expect(result.commands.match(/managed-handoff\.ts verify/g)).toHaveLength(2);
    before(result.commands, "references.ts configured", "spack-managed/case.ts install");
    before(result.commands, "restart registry scheduler server", "managed-handoff.ts verify");
    before(result.commands, "managed-handoff.ts verify", "spack-managed/case.ts restart");
    before(result.commands, "spack-managed/case.ts restart", "spack-managed/case.ts uninstall");
    before(result.commands, "references.ts managed-uninstall", "rollout.ts activate");
    before(result.commands, "rollout.ts activate", "300 server registry");
    expect(result.commands).toContain("epoch=12345678-abcd-4123-8123-123456789abc");
    expect(result.commands.lastIndexOf("checksum --strict --check")).toBeGreaterThan(
      result.commands.indexOf("rollout.ts verify"),
    );
    expect(result.commands.match(/^checksum /gm)).toHaveLength(2);
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.commands).toMatch(/docker rm -f kq-pr-test-slurm-[a-f0-9]{16}-export/);
    expect(result.commands).toMatch(
      /docker image rm kq-pr-test-slurm-[a-f0-9]{16}-artifact-exporter/,
    );
    expect(result.stdout).toContain("stage=checksum-final code=OK");
    expect(result.stdout).toContain("stage=cleanup code=OK");
  });

  const failures = [
    "config",
    "info",
    "build",
    "material-build",
    "export",
    "copy",
    "checksum-initial",
    "setup",
    "up",
    "prepare",
    "recreate",
    "verify",
    "install",
    "verify-restart",
    "rollout",
    "checksum-final",
    "cleanup",
    "cleanup-images",
  ];
  test.each(failures)("%s failure cleans partial resources without raw logs", async (failure) => {
    const result = await runRunner(["slurm", "--spack-artifact-samtools"], { failure });
    expect(result.code).not.toBe(0);
    expect(result.remaining).toEqual([]);
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.commands).toContain("docker rm -f ");
    expect(result.commands).toContain("-artifact-exporter");
    expect(result.commands).not.toMatch(/\b(logs|prune)\b/);
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    if (failures.indexOf(failure) <= failures.indexOf("verify")) {
      expect(result.commands).not.toContain("300 scheduler registry");
    }
  });

  test("keeps old config and managed modes independent of delivery", async () => {
    const config = await runRunner(["slurm", "--config"]);
    expect(config.code).toBe(0);
    expect(config.commands).not.toMatch(/\b(info|build|up|exec|down)\b/);
    for (const flag of ["--spack-managed", "--spack-samtools"]) {
      const result = await runRunner(["slurm", flag]);
      expect(result.code).toBe(0);
      expect(result.remaining).toEqual([]);
      expect(result.commands).not.toContain("pr-spack-artifact-managed.yml");
      expect(result.commands).not.toContain("managed-handoff.ts");
      expect(result.commands).toContain("build case-operator managed-builder");
      expect(result.commands).toContain("spack-managed/export-lock.ts");
      expect(result.commands).toContain("spack-case/publish.ts --verify");
      expect(result.commands).toContain("restart server |");
    }
  });
});

describe("managed artifact overlay and workflow contracts", () => {
  test("isolates delivery mounts and keeps the exporter offline", async () => {
    const base = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-test.yml"), "utf8"),
    ) as Compose;
    const overlay = parse(
      await readFile(
        join(root, "deploy/compose/docker-compose.pr-spack-artifact-managed.yml"),
        "utf8",
      ),
    ) as Compose;
    expect(Object.keys(overlay.services).sort()).toEqual([
      "artifact-control",
      "artifact-exporter",
      "registry",
    ]);
    expect(overlay.networks).toBeUndefined();
    expect(overlay.volumes).toBeUndefined();
    expect(base.services.scheduler?.networks).toEqual(["control"]);
    expect(base.services.registry?.networks).toEqual(["backend"]);
    expect(Object.values(base.networks ?? {}).every((network) => network.internal)).toBe(true);
    const exporter = overlay.services["artifact-exporter"];
    expect(exporter?.network_mode).toBe("none");
    expect(exporter?.networks).toBeUndefined();
    expect(exporter?.volumes).toBeUndefined();
    expect(exporter?.build).toMatchObject({
      dockerfile: "deploy/pr-test/spack-case/materials.Dockerfile",
      args: { KQ_PR_SPACK_CASE: "${KQ_PR_SPACK_CASE:?required}" },
      additional_contexts: {
        "scheduler-base": "service:scheduler-base",
        "test-workspace": "service:test-workspace",
      },
    });
    const control = overlay.services["artifact-control"];
    expect(control?.image).toBe("${COMPOSE_PROJECT_NAME:?required}-workspace");
    expect(control?.build).toBeUndefined();
    expect(control?.networks).toEqual(["backend"]);
    expect(control?.environment).toEqual({
      GITHUB_ACTIONS: "true",
      KQ_PR_TEST: "1",
      KQ_PR_SPACK_CASE: "${KQ_PR_SPACK_CASE:?required}",
    });
    const delivery = {
      type: "bind",
      source: "${KQ_ARTIFACT_DIRECTORY:?required}",
      target: "/imports/delivery",
      read_only: true,
      bind: { create_host_path: false },
    };
    expect(control?.volumes).toEqual([
      "case-server:/case-server",
      "case-ca:/case-ca",
      "case-control:/case-control",
      delivery,
    ]);
    expect(overlay.services.registry?.volumes).toEqual([delivery]);
    expect(overlay.services.registry?.environment).toEqual({
      SPACK_RECIPE_BOOTSTRAP_MANIFEST: "${KQ_ARTIFACT_RECIPE_BOOTSTRAP:-}",
      SPACK_MATERIAL_BOOTSTRAP_MANIFEST: "${KQ_ARTIFACT_MATERIAL_BOOTSTRAP:-}",
    });
    for (const service of Object.values(overlay.services)) {
      expect(service.ports).toBeUndefined();
      expect(service.environment?.DATABASE_URL).toBeUndefined();
      expect(service.environment?.REGISTRY_JWT_SECRET).toBeUndefined();
    }
    const workspace = await readFile(join(root, "deploy/pr-test/workspace.Dockerfile"), "utf8");
    expect(workspace).not.toContain("/opt/kq-case");
    expect(workspace).not.toContain("materials.Dockerfile");
  });

  test("scheduler matrix retains old cases and adds both isolated artifact cases", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/pr-scheduler-tests.yml"), "utf8"),
    ) as Workflow;
    expect(workflow.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(workflow.jobs);
    const matrixFlags = jobs.flatMap((job) =>
      (job.strategy?.matrix.include ?? []).map((entry) => entry.flag),
    );
    for (const flag of ["--spack-managed", "--spack-samtools", ...flags]) {
      expect(matrixFlags.filter((entry) => entry === flag)).toHaveLength(1);
    }
    for (const flag of flags) {
      const job = jobs.find((item) =>
        item.strategy?.matrix.include?.some((entry) => entry.flag === flag),
      );
      expect(job).toBeDefined();
      expect(job?.permissions ?? workflow.permissions).toEqual({ contents: "read" });
      expect(job?.strategy?.["fail-fast"]).toBe(false);
      expect(job?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(job?.if).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(job?.if).toContain("!github.event.pull_request.draft");
      const steps = job?.steps ?? [];
      expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual({
        "persist-credentials": false,
      });
      const invocation = steps.find((step) => step.run?.includes("bash deploy/pr-test/run.sh"));
      expect(invocation?.env?.CASE_FLAG).toBe("${{ matrix.flag }}");
      expect(invocation?.run).toContain('bash deploy/pr-test/run.sh slurm "$CASE_FLAG"');
      expect(invocation?.run).toContain("timeout --signal=TERM --kill-after=60s");
      expect(invocation?.run).not.toContain("${{");
      const profile = steps.find((step) => step.run?.includes("apparmor_parser --replace"));
      expect(profile?.id).toBeTruthy();
      expect(steps.find((step) => step.run?.includes("apparmor_parser --remove"))?.if).toBe(
        `always() && steps.${profile?.id}.outcome == 'success'`,
      );
      expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
    }
  });

  test("limits the managed branch to explicit validation-only requests", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/spack-material-artifacts.yml"), "utf8"),
    ) as Workflow;
    const gate = workflow.jobs["export-and-import"]?.steps?.find((step) => step.env?.REF);
    expect(gate?.env).toEqual({
      REF: "${{ github.ref }}",
      PUBLISH: "${{ inputs.publish_artifact }}",
      ACKNOWLEDGED: "${{ inputs.acknowledge_redistribution }}",
    });
    if (!gate?.run) throw new Error("Missing artifact trust gate");
    const cases: { ref: string; publish: string; acknowledged: string; allowed: boolean }[] = [];
    for (const ref of ["refs/heads/main", "refs/heads/feat/spack-material-artifacts"]) {
      cases.push(
        { ref, publish: "false", acknowledged: "false", allowed: true },
        { ref, publish: "true", acknowledged: "true", allowed: true },
        { ref, publish: "true", acknowledged: "false", allowed: false },
      );
    }
    for (const publish of ["false", "true", "", "FALSE", "0"]) {
      cases.push({
        ref: "refs/heads/feat/spack-artifact-managed",
        publish,
        acknowledged: "true",
        allowed: publish === "false",
      });
    }
    cases.push({
      ref: "refs/heads/feat/spack-artifact-managed",
      publish: "false",
      acknowledged: "false",
      allowed: true,
    });
    for (const ref of [
      "refs/heads/other",
      "refs/pull/8/merge",
      "refs/tags/main",
      "refs/heads/feat/spack-artifact-managed-extra",
    ]) {
      for (const publish of ["false", "true"]) {
        cases.push({ ref, publish, acknowledged: "true", allowed: false });
      }
    }
    for (const input of cases) {
      const child = Bun.spawn({
        cmd: ["bash", "-euo", "pipefail", "-c", gate.run],
        env: {
          PATH: process.env.PATH,
          REF: input.ref,
          PUBLISH: input.publish,
          ACKNOWLEDGED: input.acknowledged,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ ...input, allowed: code === 0 }).toEqual(input);
    }
  });
});
