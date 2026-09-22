import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSeq, parse, parseDocument } from "yaml";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const flags = ["--spack-web-hello", "--spack-web-samtools"];
const endpoints = "docker-compose.pr-spack-web-endpoints.yml";
const serverId = "a".repeat(64);
const registryId = "b".repeat(64);
const backendId = "c".repeat(64);
const controlId = "d".repeat(64);

interface Compose {
  services: Record<
    string,
    {
      environment?: Record<string, string>;
      networks?: string[];
      ports?: { target: number; host_ip: string; published?: string }[];
      volumes?: unknown[];
    }
  >;
  networks?: Record<string, { internal: boolean }>;
}

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      strategy?: {
        "fail-fast": boolean;
        matrix: { include?: { flag: string; web?: boolean }[] };
      };
      steps?: Step[];
    }
  >;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fakeDocker = `#!/bin/bash
set -euo pipefail
command="$*"
printf 'docker %s | bootstrap=%s/%s receipt=%s ambient=%s/%s/%s/%s\\n' \
  "\${command//$'\\n'/ }" "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP-unset}" \
  "\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP-unset}" "\${KQ_ARTIFACT_WEB_RECEIPT_DIRECTORY-unset}" \
  "\${COMPOSE_FILE-unset}" "\${COMPOSE_PROFILES-unset}" "\${COMPOSE_ENV_FILES-unset}" \
  "\${KQ_PR_APT_MIRROR-unset}" >> "$WEB_TRACE"
case " $* " in
  *" build scheduler "*)
    touch "$WEB_STATE/$COMPOSE_PROJECT_NAME-scheduler.image" \
      "$WEB_STATE/$COMPOSE_PROJECT_NAME-workspace.image" ;;
  *" build artifact-exporter managed-builder "*)
    touch "$WEB_STATE/$COMPOSE_PROJECT_NAME-artifact-exporter.image" \
      "$WEB_STATE/$COMPOSE_PROJECT_NAME-managed-builder.image" ;;
  *"deploy/pr-test/spack-artifacts/export.ts "*)
    touch "$WEB_STATE/$COMPOSE_PROJECT_NAME-export.container" ;;
  *" up "*)
    if [[ "$*" == *"${endpoints}"* ]]; then touch "$WEB_STATE/endpoint-network"; fi ;;
  *" port server 3000 "*)
    if [[ "$WEB_FAIL" == server-port ]]; then echo 0.0.0.0:13000
    else echo 127.0.0.1:13000; fi ;;
  *" port registry 3100 "*)
    if [[ "$WEB_FAIL" == registry-port ]]; then echo 0.0.0.0:13100
    else echo 127.0.0.1:13100; fi ;;
  *" ps -q server "*) echo "${serverId}" ;;
  *" ps -q registry "*) echo "${registryId}" ;;
  *"deploy/pr-test/spack-artifacts/managed-handoff.ts prepare "*)
    [[ -f "$KQ_ARTIFACT_WEB_RECEIPT_DIRECTORY/web-binding.json" ]]
    [[ "$WEB_FAIL" != prepare ]] || exit 21 ;;
  *"deploy/pr-test/spack-artifacts/managed-handoff.ts verify "*)
    [[ "$WEB_FAIL" != verify ]] || exit 22 ;;
  *"deploy/pr-test/spack-case/rollout.ts activate "*)
    echo 12345678-abcd-4123-8123-123456789abc ;;
  *" down "*)
    [[ "$WEB_FAIL" != cleanup ]] || exit 23
    [[ "$*" == *"${endpoints}"* ]]
    rm -f "$WEB_STATE/endpoint-network" ;;
  *" logs "*) echo private-container-token ;;
esac
if [[ "$1" == cp ]]; then
  mkdir -p "$3"
  printf 'fixture\\n' > "$3/checksums.txt"
elif [[ "$1" == rm ]]; then
  shift
  if [[ "$1" == -f ]]; then shift; fi
  rm -f "$WEB_STATE/$1.container"
elif [[ "$1" == image && "$2" == inspect ]]; then
  [[ -f "$WEB_STATE/$3.image" ]]
elif [[ "$1" == image && "$2" == rm ]]; then
  shift 2
  for image in "$@"; do rm -f "$WEB_STATE/$image.image"; done
elif [[ "$1" == inspect ]]; then
  [[ "$2" == --format && ( "$4" == "${serverId}" || "$4" == "${registryId}" ) ]]
  case "$3" in
    '{{json .HostConfig.PortBindings}}')
      isolation="$(grep -c ' ps -q server ' "$WEB_TRACE")"
      if [[ "$WEB_FAIL" == published-port ||
            ( "$WEB_FAIL" == published-port-restart && "$isolation" == 2 ) ]]; then
        echo '{"3000/tcp":[{"HostPort":"13000"}]}'
      else echo '{}'; fi ;;
    '{{range .NetworkSettings.Networks}}{{println .NetworkID}}{{end}}')
      echo "${backendId}"
      if [[ "$4" == "${serverId}" ]]; then echo "${controlId}"; fi ;;
    *) exit 70 ;;
  esac
elif [[ "$1" == network && "$2" == inspect ]]; then
  [[ "$3" == --format && "$4" == '{{.Internal}}' ]]
  [[ "$5" == "${backendId}" || "$5" == "${controlId}" ]]
  isolation="$(grep -c ' ps -q server ' "$WEB_TRACE")"
  if [[ "$5" == "${controlId}" &&
        ( "$WEB_FAIL" == external-network ||
          ( "$WEB_FAIL" == external-network-rollout && "$isolation" == 3 ) ) ]]; then
    echo false
  else echo true; fi
fi
`;

const fakeBun = `#!/bin/bash
set -euo pipefail
printf 'bun %s\\n' "$*" >> "$WEB_TRACE"
[[ "$KQ_WEB_SERVER_PROXY_TARGET" == http://127.0.0.1:13000 ]]
[[ "$KQ_WEB_REGISTRY_PROXY_TARGET" == http://127.0.0.1:13100 ]]
[[ "$KQ_ARTIFACT_RESULT_PATH" == "$KQ_ARTIFACT_WEB_RECEIPT_DIRECTORY/web-binding.json" ]]
[[ "$KQ_ARTIFACT_REFERENCE_PATH" == /* ]]
[[ ! -e "$KQ_ARTIFACT_REFERENCE_PATH" ]]
if [[ "$*" == 'deploy/pr-test/spack-artifacts/verify.ts empty' ]]; then
  [[ "$WEB_FAIL" != empty ]] || exit 24
elif [[ "$*" == 'run --cwd packages/web e2e --config e2e/material-artifacts.config.ts' ]]; then
  [[ "$KQ_ARTIFACT_WEB_URL" == http://127.0.0.1:15173 ]]
  [[ "$WEB_FAIL" != browser ]] || exit 25
  printf '{}\\n' > "$KQ_ARTIFACT_RESULT_PATH"
else
  exit 71
fi
`;

async function runRunner(args: string[], failure = "none", githubActions = "true") {
  const directory = await mkdtemp(join(tmpdir(), "kq-web-managed-test-"));
  temporary.push(directory);
  const runnerTemp = join(directory, "runner-temp");
  const tools = join(directory, "tools");
  const state = join(directory, "state");
  await Promise.all([mkdir(runnerTemp), mkdir(tools), mkdir(state)]);
  const scripts = {
    docker: fakeDocker,
    bun: fakeBun,
    timeout: `#!/bin/bash
set -euo pipefail
printf 'timeout %s\\n' "$*" >> "$WEB_TRACE"
while [[ "$1" == --* ]]; do shift; done
[[ "$1" =~ ^[1-9][0-9]*[smh]$ ]]
shift
exec "$@"
`,
    sha256sum: `#!/bin/bash
set -euo pipefail
[[ "$*" == '--strict --check checksums.txt' && -f checksums.txt ]]
printf 'checksum %s\\n' "$PWD" >> "$WEB_TRACE"
`,
  };
  for (const [name, content] of Object.entries(scripts)) {
    await writeFile(join(tools, name), content, { mode: 0o755 });
  }
  const log = join(directory, "commands");
  const child = Bun.spawn({
    cmd: ["bash", join(root, "deploy/pr-test/run.sh"), ...args],
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      WEB_TRACE: log,
      WEB_FAIL: failure,
      WEB_STATE: state,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ACTIONS: githubActions,
      COMPOSE_PROJECT_NAME: "inherited-must-not-use",
      COMPOSE_FILE: "inherited-must-not-use",
      COMPOSE_PROFILES: "inherited-must-not-use",
      COMPOSE_ENV_FILES: "inherited-must-not-use",
      KQ_PR_APT_MIRROR: "inherited-must-not-use",
      KQ_ARTIFACT_DIRECTORY: "inherited-must-not-use",
      KQ_ARTIFACT_WEB_RECEIPT_DIRECTORY: "inherited-must-not-use",
      KQ_ARTIFACT_RECIPE_BOOTSTRAP: "inherited-must-not-use",
      KQ_ARTIFACT_MATERIAL_BOOTSTRAP: "inherited-must-not-use",
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
  expect(await readdir(runnerTemp)).toEqual([]);
  return {
    code,
    stdout,
    stderr,
    commands,
    calls: commands.trim().split("\n"),
    resources: await readdir(state),
  };
}

describe("Web-to-managed runner contract with fake tools", () => {
  test.each(flags)("%s is Actions-only, Slurm-only and a strict single flag", async (flag) => {
    const rejected: [string[], string][] = [
      [["slurm", flag], "false"],
      [["pbs", flag], "true"],
      [["slurm", flag, "--config"], "true"],
      [["slurm", `${flag}-extra`], "true"],
    ];
    for (const [args, actions] of rejected) {
      const result = await runRunner(args, "none", actions);
      expect(result.code).toBe(2);
      expect(result.commands).toBe("");
    }
  });

  test.each(flags)("%s imports through Web before managed installation", async (flag) => {
    const result = await runRunner(["slurm", flag]);
    expect(result.code).toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.commands).not.toMatch(/inherited-must-not-use|publish\.ts|export-lock\.ts/);
    expect(result.commands).not.toMatch(/case-operator|case-native|\blogs\b|\bprune\b/);
    const selected = flag === "--spack-web-hello" ? "hello" : "samtools";
    expect(result.commands).toContain(
      `/opt/kq-case /out/delivery ${selected} public/pr-${selected}-recipes public/pr-${selected}-sources`,
    );
    const exportCalls = result.calls.filter((line) => line.includes("spack-artifacts/export.ts"));
    expect(exportCalls).toHaveLength(1);
    expect(result.calls.filter((line) => line.startsWith("docker cp "))).toHaveLength(1);
    expect(result.calls.filter((line) => line.startsWith("checksum "))).toHaveLength(2);
    expect(result.calls.filter((line) => line.startsWith("bun "))).toEqual([
      "bun deploy/pr-test/spack-artifacts/verify.ts empty",
      "bun run --cwd packages/web e2e --config e2e/material-artifacts.config.ts",
    ]);
    const stages = [
      "spack-artifacts/export.ts",
      "docker cp ",
      "checksum ",
      "artifact-control bun deploy/pr-test/spack-case/setup.ts",
      "300 server registry",
      "port server 3000",
      "port registry 3100",
      "bun deploy/pr-test/spack-artifacts/verify.ts empty",
      "bun run --cwd packages/web e2e --config e2e/material-artifacts.config.ts",
      "managed-handoff.ts prepare",
      "up -d --force-recreate --no-build --wait --wait-timeout 300 registry server",
      "ps -q server",
      `docker inspect --format {{json .HostConfig.PortBindings}} ${serverId}`,
      `docker network inspect --format {{.Internal}} ${controlId}`,
      "ps -q registry",
      `docker inspect --format {{json .HostConfig.PortBindings}} ${registryId}`,
      "managed-handoff.ts verify",
      "300 scheduler registry",
      "references.ts configured",
      "spack-managed/case.ts install",
      "restart registry scheduler server",
      "ps -q server",
      `docker network inspect --format {{.Internal}} ${controlId}`,
      "ps -q registry",
      "managed-handoff.ts verify",
      "spack-managed/case.ts restart",
      "spack-managed/case.ts uninstall",
      "rollout.ts activate",
      "up -d --force-recreate --no-build --wait --wait-timeout 300 server registry",
      "ps -q server",
      `docker network inspect --format {{.Internal}} ${controlId}`,
      "ps -q registry",
      "rollout.ts verify",
      "checksum ",
      "down --volumes --remove-orphans --rmi local",
    ];
    let previous = -1;
    for (const stage of stages) {
      const next = result.calls.findIndex(
        (line, index) => index > previous && line.includes(stage),
      );
      expect({ stage, found: next > previous }).toEqual({ stage, found: true });
      previous = next;
    }
    for (const call of result.calls.filter((line) => line.startsWith("docker "))) {
      expect(call).toContain("bootstrap=unset/unset");
      if (!call.startsWith("docker compose ") || !call.includes(" -p ")) continue;
      const actualOverlays = [...call.matchAll(/-f \S*\/(docker-compose\.[^\s]+\.yml)/g)].map(
        (match) => match[1],
      );
      expect(actualOverlays).toEqual([
        "docker-compose.pr-test.yml",
        "docker-compose.pr-spack-case.yml",
        "docker-compose.pr-spack-managed.yml",
        "docker-compose.pr-spack-artifact-managed.yml",
        "docker-compose.pr-spack-web-managed.yml",
        ...(call.includes(endpoints) ? [endpoints] : []),
      ]);
      for (const overlay of [
        "pr-test",
        "pr-spack-case",
        "pr-spack-managed",
        "pr-spack-artifact-managed",
        "pr-spack-web-managed",
      ]) {
        expect(call).toContain(`docker-compose.${overlay}.yml`);
      }
      const temporaryEndpoint = /300 server registry| port (server|registry) | down /.test(call);
      if (call.includes("config --quiet") || call.includes("ps --all")) continue;
      const hasEndpoints = call.includes(endpoints);
      expect(hasEndpoints).toBe(temporaryEndpoint && !call.includes("--force-recreate"));
    }
    expect(result.commands).toContain("/web-receipt");
    for (const service of ["server", "registry"]) {
      expect(result.calls.filter((line) => line.includes(`ps -q ${service}`))).toHaveLength(3);
    }
    expect(result.stdout.match(/Spack Web managed: stage=isolation code=OK/g)).toHaveLength(3);
    for (const image of ["scheduler", "workspace", "managed-builder", "artifact-exporter"]) {
      expect(result.commands).toMatch(
        new RegExp(`docker image rm kq-pr-test-slurm-[a-f0-9]{16}-${image}`),
      );
    }
    expect(result.stdout).toContain("stage=cleanup code=OK");
  });

  const failures = [
    "server-port",
    "registry-port",
    "empty",
    "browser",
    "prepare",
    "published-port",
    "external-network",
    "verify",
  ];
  test.each(failures)("%s failure blocks scheduler and cleans the Web stack", async (failure) => {
    const result = await runRunner(["slurm", "--spack-web-samtools"], failure);
    expect(result.code).not.toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.commands).not.toContain("300 scheduler registry");
    expect(result.commands).not.toMatch(/\blogs\b|\bprune\b/);
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-container-token");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    const cleanup = result.calls.find((line) => line.includes("down --volumes"));
    expect(cleanup).toContain(endpoints);
    expect(cleanup).toContain("--remove-orphans --rmi local");
    expect(result.commands).toContain("docker rm -f ");
  });

  test("failed Web teardown cannot report success", async () => {
    const result = await runRunner(["slurm", "--spack-web-hello"], "cleanup");
    expect(result.code).not.toBe(0);
    expect(result.resources).toEqual(["endpoint-network"]);
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    expect(result.stdout).not.toContain("stage=cleanup code=OK");
  });

  const lateFailures = ["published-port-restart", "external-network-rollout"];
  test.each(lateFailures)("%s stops later phases and cleans the Web stack", async (failure) => {
    const result = await runRunner(["slurm", "--spack-web-samtools"], failure);
    expect(result.code).not.toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.commands).toContain("spack-managed/case.ts install");
    expect(result.calls.filter((line) => line.startsWith("checksum "))).toHaveLength(1);
    expect(result.stdout).not.toContain("stage=checksum-final code=OK");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    expect(result.stdout).not.toContain("stage=cleanup code=OK");
    const cleanup = result.calls.find((line) => line.includes("down --volumes"));
    expect(cleanup).toContain(endpoints);
    expect(cleanup).toContain("--remove-orphans --rmi local");
    expect(result.commands).toContain("docker rm -f ");
    const inspections = result.calls.filter((line) => line.includes("ps -q server"));
    if (failure === "published-port-restart") {
      expect(inspections).toHaveLength(2);
      expect(result.stderr).toContain("stage=isolation code=PORTS");
      expect(result.commands).not.toContain("spack-managed/case.ts restart");
      expect(result.commands).not.toContain("spack-managed/case.ts uninstall");
      expect(result.commands).not.toContain("rollout.ts");
    } else {
      expect(inspections).toHaveLength(3);
      expect(result.stderr).toContain("stage=isolation code=EGRESS");
      expect(result.commands).toContain("spack-managed/case.ts uninstall");
      expect(result.commands).toContain("rollout.ts activate");
      expect(result.commands).not.toContain("rollout.ts verify");
    }
  });
});

describe("Web-to-managed overlays and workflow", () => {
  test("removes Registry delivery and exposes only temporary loopback endpoints", async () => {
    const permanent = parseDocument(
      await readFile(join(root, "deploy/compose/docker-compose.pr-spack-web-managed.yml"), "utf8"),
      { customTags: [{ tag: "!override", collection: "seq", resolve: (value) => value }] },
    );
    expect(permanent.errors).toEqual([]);
    const volumes = permanent.getIn(["services", "registry", "volumes"], true);
    expect(isSeq(volumes) && volumes.tag).toBe("!override");
    const overlay = permanent.toJS() as Compose;
    expect(Object.keys(overlay.services).sort()).toEqual(["artifact-control", "registry"]);
    expect(overlay.services.registry?.volumes).toEqual([
      "registry-data:/var/lib/kuintessence/registry",
    ]);
    expect(overlay.services.registry?.environment).toEqual({
      SPACK_RECIPE_BOOTSTRAP_MANIFEST: "",
      SPACK_MATERIAL_BOOTSTRAP_MANIFEST: "",
    });
    expect(overlay.services["artifact-control"]?.environment).toMatchObject({
      KQ_ARTIFACT_IMPORT_MODE: "web",
    });
    expect(overlay.services["artifact-control"]?.volumes).toContainEqual({
      type: "bind",
      source: "${KQ_ARTIFACT_WEB_RECEIPT_DIRECTORY:?required}",
      target: "/imports/web-receipt",
      read_only: true,
      bind: { create_host_path: false },
    });
    expect(overlay.networks).toBeUndefined();
    for (const service of Object.values(overlay.services)) {
      expect(service.ports).toBeUndefined();
      expect(service.networks).toBeUndefined();
    }
    const temporaryOverlay = parse(
      await readFile(join(root, "deploy/compose", endpoints), "utf8"),
    ) as Compose;
    expect(Object.keys(temporaryOverlay.services).sort()).toEqual(["registry", "server"]);
    expect(temporaryOverlay.networks).toEqual({ "artifact-web": { internal: false } });
    const listeners: [string, number][] = [
      ["server", 3000],
      ["registry", 3100],
    ];
    for (const [name, port] of listeners) {
      expect(temporaryOverlay.services[name]).toEqual({
        networks: ["artifact-web"],
        ports: [{ target: port, host_ip: "127.0.0.1" }],
      });
    }
  });

  test("gates Web-only dependencies and forbids managed artifact uploads", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/pr-scheduler-tests.yml"), "utf8"),
    ) as Workflow;
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const flag of flags) {
      const jobs = Object.values(workflow.jobs).filter((job) =>
        job.strategy?.matrix.include?.some((entry) => entry.flag === flag),
      );
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job?.strategy?.["fail-fast"]).toBe(false);
      expect(job?.if).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      for (const entry of job?.strategy?.matrix.include ?? []) {
        expect(entry.web).toBe(flags.includes(entry.flag));
      }
      const steps = job?.steps ?? [];
      const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
      expect(bun?.with).toEqual({ "bun-version": "1.4.2" });
      const install = steps.find((step) => step.run?.includes("bun install --frozen-lockfile"));
      const proto = steps.find((step) => step.run?.includes("proto generate"));
      const browser = steps.find((step) => step.run?.includes("bun run e2e:install"));
      for (const step of [bun, install, proto, browser]) {
        expect(step?.if).toBe("matrix.web == true");
      }
      expect(browser?.["working-directory"]).toBe("packages/web");
      expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
      expect(steps.find((step) => step.run?.includes("bash deploy/pr-test/run.sh"))?.env).toEqual({
        CASE_FLAG: "${{ matrix.flag }}",
      });
      const cleanup = steps.find((step) => step.run?.includes("apparmor_parser --remove"));
      expect(cleanup?.if).toBe("always() && steps.managed-apparmor.outcome == 'success'");
    }
  });

  test("the Web-managed branch cannot publish artifacts even with acknowledgement", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/spack-material-artifacts.yml"), "utf8"),
    ) as Workflow;
    const gate = workflow.jobs["export-and-import"]?.steps?.find((step) => step.env?.REF)?.run;
    if (!gate) throw new Error("Missing trusted artifact request gate");
    for (const publish of ["false", "true", "", "FALSE", "0"]) {
      const child = Bun.spawn({
        cmd: ["bash", "-euo", "pipefail", "-c", gate],
        env: {
          PATH: process.env.PATH,
          REF: "refs/heads/feat/spack-web-managed",
          PUBLISH: publish,
          ACKNOWLEDGED: "true",
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
      expect({ publish, allowed: code === 0 }).toEqual({ publish, allowed: publish === "false" });
    }
  });
});
