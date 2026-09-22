import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const runner = join(root, "deploy/pr-test/spack-artifacts/run.sh");
const temporary: string[] = [];

interface Service {
  environment?: Record<string, string>;
  networks?: string[];
  network_mode?: string;
  ports?: { target: number; host_ip: string; published?: string }[];
  volumes?: (
    | string
    | {
        type: string;
        source: string;
        target: string;
        read_only: boolean;
        bind: { create_host_path: boolean };
      }
  )[];
}

interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { internal: boolean }>;
  volumes?: Record<string, unknown>;
}

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: Record<
    string,
    {
      inputs?: Record<
        string,
        { type: string; default?: unknown; required?: boolean; options?: string[] }
      >;
    }
  >;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string;
      uses?: string;
      strategy?: { "fail-fast": boolean; matrix: { case: string[] } };
      with?: Record<string, unknown>;
      steps?: Step[];
    }
  >;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("material artifact deployment contracts", () => {
  test("overlay only adds an offline exporter and loopback import listeners", async () => {
    const base = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-test.yml"), "utf8"),
    ) as Compose;
    const overlay = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-spack-artifacts.yml"), "utf8"),
    ) as Compose;
    expect(Object.keys(overlay.services).sort()).toEqual([
      "artifact-operator",
      "registry",
      "server",
    ]);
    expect(overlay.services["artifact-operator"]?.network_mode).toBe("none");
    expect(overlay.services.server?.ports).toEqual([{ target: 3000, host_ip: "127.0.0.1" }]);
    expect(overlay.services.registry?.ports).toEqual([{ target: 3100, host_ip: "127.0.0.1" }]);
    expect(overlay.services.registry?.volumes).toEqual([
      {
        type: "bind",
        source: `\${KQ_ARTIFACT_DIRECTORY:?required}`,
        target: "/imports",
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    expect(overlay.services.registry?.environment).toEqual({
      SPACK_RECIPE_BOOTSTRAP_MANIFEST: `\${KQ_ARTIFACT_RECIPE_BOOTSTRAP:-}`,
      SPACK_MATERIAL_BOOTSTRAP_MANIFEST: `\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP:-}`,
    });
    expect(base.services.postgres?.volumes).toContain("pg-data:/var/lib/postgresql/data");
    expect(base.services.registry?.volumes).toContain(
      "registry-data:/var/lib/kuintessence/registry",
    );
    expect(base.volumes?.["pg-data"]).toBeNull();
    expect(base.volumes?.["registry-data"]).toBeNull();
    expect(overlay.volumes).toBeUndefined();
    expect(overlay.networks).toBeUndefined();
    expect(Object.values(base.networks ?? {}).every((network) => network.internal)).toBe(true);
    expect(base.services.scheduler?.networks).toEqual(["control"]);
    expect(base.services.registry?.networks).toEqual(["backend"]);
    expect(base.services.server?.networks).toEqual(["backend", "control"]);
    expect(base.services.server?.environment?.SPACK_MATERIAL_DELIVERY_ENABLED).toBe("false");
    expect(base.services.scheduler?.environment?.AGENT_SPACK_INSTALL_ENABLED).toBe("false");
    expect(base.services.scheduler?.environment?.SPACK_REGISTRY_URL).toBeUndefined();
    expect(base.services.scheduler?.environment?.SERVER_HTTP_URL).toBe("http://server:3000");
    expect(base.services.scheduler?.environment?.SERVER_GRPC_URL).toBe("http://server:3001");
    expect(overlay.services.server?.environment?.SPACK_MATERIAL_DELIVERY_ENABLED).toBeUndefined();
  });

  test("uploads only the delivery directory after success and both explicit opt-ins", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/spack-material-artifacts.yml"), "utf8"),
    ) as Workflow;
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch?.inputs?.case).toMatchObject({
      type: "choice",
      options: ["hello", "samtools"],
    });
    expect(workflow.on.workflow_call?.inputs?.case).toMatchObject({
      type: "string",
      required: true,
    });
    for (const trigger of ["workflow_call", "workflow_dispatch"]) {
      for (const flag of ["publish_artifact", "acknowledge_redistribution"]) {
        expect(workflow.on[trigger]?.inputs?.[flag]).toMatchObject({
          type: "boolean",
          default: false,
        });
      }
    }
    const steps = workflow.jobs["export-and-import"]?.steps ?? [];
    const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.if).toBe(
      "success() && inputs.publish_artifact && inputs.acknowledge_redistribution",
    );
    expect(uploads[0]?.with).toMatchObject({
      path: `\${{ runner.temp }}/kq-spack-material-artifact/`,
      "retention-days": 7,
      "compression-level": 0,
      "include-hidden-files": false,
      "if-no-files-found": "error",
    });
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual({
      "persist-credentials": false,
    });
    const invocation = steps.find((step) => step.run?.includes("spack-artifacts/run.sh"));
    expect(invocation?.env).toEqual({
      MATERIAL_CASE: `\${{ inputs.case }}`,
      RECIPE_REPOSITORY: `\${{ inputs.recipe_repository }}`,
      MATERIAL_REPOSITORY: `\${{ inputs.material_repository }}`,
    });
    expect(invocation?.run).toContain(
      '"$MATERIAL_CASE" "$RECIPE_REPOSITORY" "$MATERIAL_REPOSITORY"',
    );
    expect(invocation?.run).not.toContain("${{");
  });

  test("full CI calls both cases without authorizing artifact publication", async () => {
    const workflow = parse(
      await readFile(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow;
    const job = workflow.jobs["spack-artifact-imports"];
    expect(job?.if).toBe("github.event_name == 'workflow_dispatch' && inputs.run_runtime_checks");
    expect(job?.needs).toBe("lint-and-typecheck");
    expect(job?.uses).toBe("./.github/workflows/spack-material-artifacts.yml");
    expect(job?.strategy).toEqual({ "fail-fast": false, matrix: { case: ["hello", "samtools"] } });
    expect(job?.with).toMatchObject({
      case: `\${{ matrix.case }}`,
      publish_artifact: false,
      acknowledge_redistribution: false,
    });
  });
});

const fakeDocker = `#!/bin/bash
set -euo pipefail
printf 'docker %s | recipe=%s material=%s case=%s ambient=%s/%s/%s/%s\\n' \
  "$*" "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP-unset}" "\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP-unset}" \
  "\${KQ_PR_SPACK_CASE-unset}" "\${COMPOSE_FILE-unset}" "\${COMPOSE_PROFILES-unset}" \
  "\${COMPOSE_ENV_FILES-unset}" "\${KQ_PR_APT_MIRROR-unset}" >> "$ARTIFACT_TRACE"
case " $* " in
  *" config --quiet "*) [[ "$ARTIFACT_FAIL" != config ]] || exit 11 ;;
  *" build artifact-operator "*) [[ "$ARTIFACT_FAIL" != build ]] || exit 19 ;;
  *" deploy/pr-test/spack-artifacts/export.ts "*)
    (
      while [[ "$1" != --entrypoint ]]; do shift; done
      [[ "$2" == bash && "$3" == artifact-operator && "$4" == -euc ]]
      [[ "$5" == $'mkdir -m 0755 /out\\nexec bun deploy/pr-test/spack-artifacts/export.ts "$@"' ]]
      shift 5
      [[ $# == 6 && "$1" == export && "$2" == /opt/kq-case && "$3" == /out/delivery ]]
      printf 'export-arguments: %s\\n' "$*" >> "$ARTIFACT_TRACE"
    )
    [[ "$ARTIFACT_FAIL" != export ]] || exit 23 ;;
  *" up "*)
    [[ "$ARTIFACT_FAIL" != up ]] || exit 29
    if [[ ! -f "$ARTIFACT_STATE/active" ]]; then
      generation=0
      if [[ -f "$ARTIFACT_STATE/generation" ]]; then generation="$(cat "$ARTIFACT_STATE/generation")"; fi
      printf '%s' "$((generation + 1))" > "$ARTIFACT_STATE/generation"
      touch "$ARTIFACT_STATE/active"
    fi
    printf 'store-generation=%s\\n' "$(cat "$ARTIFACT_STATE/generation")" >> "$ARTIFACT_TRACE" ;;
  *" port server 3000 "*)
    if [[ "$ARTIFACT_FAIL" == listener ]]; then echo 0.0.0.0:13000; else echo 127.0.0.1:13000; fi ;;
  *" port registry 3100 "*) echo 127.0.0.1:13100 ;;
  *" down "*)
    [[ " $* " == *" --volumes "* ]] || exit 72
    [[ "$ARTIFACT_FAIL" != down ]] || exit 71
    if [[ "$ARTIFACT_FAIL" == cleanup && " $* " == *" --rmi local "* ]]; then exit 73; fi
    rm -f "$ARTIFACT_STATE/active" ;;
esac
if [[ "\${1:-}" == cp ]]; then
  [[ "$ARTIFACT_FAIL" != copy ]] || exit 31
  destination="$3"
  mkdir -p "$destination/recipe-pack" "$destination/material-pack/blobs"
  printf fixture > "$destination/README.md"
  printf '{}' > "$destination/provenance.json"
  printf '{}' > "$destination/recipe-pack/manifest.json"
  printf fixture-bundle > "$destination/recipe-pack/recipes.bundle"
  printf '{}' > "$destination/material-pack/manifest.json"
  printf fixture-source > "$destination/material-pack/blobs/payload"
  (cd "$destination" && sha256sum README.md provenance.json recipe-pack/manifest.json \
    recipe-pack/recipes.bundle material-pack/manifest.json material-pack/blobs/payload > checksums.txt)
fi
`;

const fakeBun = `#!/bin/bash
set -euo pipefail
printf 'bun %s | recipe=%s material=%s server=%s registry=%s\\n' "$*" \
  "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP-unset}" "\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP-unset}" \
  "\${KQ_WEB_SERVER_PROXY_TARGET-unset}" "\${KQ_WEB_REGISTRY_PROXY_TARGET-unset}" >> "$ARTIFACT_TRACE"
if [[ "$1" == deploy/pr-test/spack-artifacts/verify.ts ]]; then
  phase="$2"
  [[ "$ARTIFACT_FAIL" != "$phase" ]] || exit 41
  [[ "$KQ_WEB_SERVER_PROXY_TARGET" == http://127.0.0.1:13000 ]]
  [[ "$KQ_WEB_REGISTRY_PROXY_TARGET" == http://127.0.0.1:13100 ]]
  case "$phase" in
    bootstrap)
      [[ "$(cat "$ARTIFACT_STATE/generation")" == 1 ]]
      [[ "$KQ_ARTIFACT_RECIPE_BOOTSTRAP" == /imports/recipe-pack/manifest.json ]]
      [[ "$KQ_ARTIFACT_MATERIAL_BOOTSTRAP" == /imports/material-pack/manifest.json ]]
      printf binding > "$KQ_ARTIFACT_REFERENCE_PATH" ;;
    bootstrap-restart)
      [[ "$(cat "$ARTIFACT_STATE/generation")" == 1 ]]
      [[ -f "$KQ_ARTIFACT_REFERENCE_PATH" ]] ;;
    empty)
      [[ "$(cat "$ARTIFACT_STATE/generation")" == 2 ]]
      [[ -z "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP+x}\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP+x}" ]]
      [[ ! -e "$KQ_ARTIFACT_RESULT_PATH" ]] ;;
    web|web-restart)
      [[ "$(cat "$ARTIFACT_STATE/generation")" == 2 ]]
      [[ -z "\${KQ_ARTIFACT_RECIPE_BOOTSTRAP+x}\${KQ_ARTIFACT_MATERIAL_BOOTSTRAP+x}" ]]
      cmp "$KQ_ARTIFACT_REFERENCE_PATH" "$KQ_ARTIFACT_RESULT_PATH" ;;
    *) exit 97 ;;
  esac
  if [[ "$phase" == web-restart && "$ARTIFACT_FAIL" == checksum ]]; then
    printf changed > "$KQ_ARTIFACT_DIRECTORY/material-pack/blobs/payload"
  fi
else
  [[ "$*" == "run --cwd packages/web e2e --config e2e/material-artifacts.config.ts" ]]
  [[ "$ARTIFACT_FAIL" != browser ]] || exit 47
  [[ "$(cat "$ARTIFACT_STATE/generation")" == 2 ]]
  cp "$KQ_ARTIFACT_REFERENCE_PATH" "$KQ_ARTIFACT_RESULT_PATH"
fi
`;

// These executables simulate runner control flow only; they do not build, export,
// upload, start services, or establish real bootstrap/browser import correctness.
async function runFixture(
  args: readonly string[] = ["hello", "public/fixture-recipes", "public/fixture-sources"],
  failure = "none",
  env: Record<string, string> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "kq-artifact-runner-test-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  const runnerTemp = join(directory, "runner-temp");
  const trace = join(directory, "trace");
  for (const path of [bin, state, runnerTemp]) await mkdir(path);
  await writeFile(trace, "");
  await writeFile(join(bin, "docker"), fakeDocker, { mode: 0o700 });
  await writeFile(join(bin, "bun"), fakeBun, { mode: 0o700 });
  await writeFile(
    join(bin, "openssl"),
    `#!/bin/bash
set -euo pipefail
[[ "$1" == rand && "$2" == -hex ]]
printf 'openssl rand -hex %s\\n' "$3" >> "$ARTIFACT_TRACE"
case "$3" in
  8) printf '%s\\n' 0123456789abcdef ;;
  32) printf '%s\\n' ${"a".repeat(64)} ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o700 },
  );
  const child = Bun.spawn({
    cmd: ["/bin/bash", runner, ...args],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: runnerTemp,
      ARTIFACT_TRACE: trace,
      ARTIFACT_STATE: state,
      ARTIFACT_FAIL: failure,
      COMPOSE_PROJECT_NAME: "production-must-not-touch",
      COMPOSE_FILE: "inherited-must-not-use",
      COMPOSE_PROFILES: "inherited-must-not-use",
      COMPOSE_ENV_FILES: "inherited-must-not-use",
      KQ_PR_APT_MIRROR: "inherited-must-not-use",
      KQ_PR_SPACK_CASE: "inherited-must-not-use",
      KQ_ARTIFACT_RECIPE_BOOTSTRAP: "inherited-must-not-use",
      KQ_ARTIFACT_MATERIAL_BOOTSTRAP: "inherited-must-not-use",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      code,
      stdout,
      stderr,
      trace: await readFile(trace, "utf8"),
      runnerTemp,
      output: join(runnerTemp, "kq-spack-material-artifact"),
    };
  } finally {
    clearTimeout(timer);
  }
}

describe("material artifact runner (fake tools, Actions only)", () => {
  test.each(["false", "", "TRUE"])("rejects non-Actions value %j before tools", async (value) => {
    const result = await runFixture(undefined, "none", { GITHUB_ACTIONS: value });
    expect(result.code).toBe(2);
    expect(result.trace).toBe("");
    expect(result.stderr).toContain("require a disposable Actions runner");
  });

  test.each([
    { args: [] },
    { args: ["hello"] },
    { args: ["hello", "public/fixture-recipes"] },
    { args: ["hello", "public/fixture-recipes", "public/fixture-sources", "extra"] },
    { args: ["unknown", "public/fixture-recipes", "public/fixture-sources"] },
    { args: ["samtools;false", "public/fixture-recipes", "public/fixture-sources"] },
  ])("rejects incomplete or unsupported arguments %j before tools", async ({ args }) => {
    const result = await runFixture(args);
    expect(result.code).toBe(2);
    expect(result.trace).toBe("");
    expect(await readdir(result.runnerTemp)).toEqual([]);
  });

  const invalidTempPaths = ["", "relative", "/missing-actions-temporary-directory"];
  test.each(invalidTempPaths)("rejects unusable Actions temporary directory %j", async (value) => {
    const result = await runFixture(undefined, "none", { RUNNER_TEMP: value });
    expect(result.code).toBe(2);
    expect(result.trace).toBe("");
  });

  const artifactCases = ["hello", "samtools"];
  for (const caseId of artifactCases) {
    test(`${caseId} preserves namespaces and isolates imports`, async () => {
      const recipe = "org/provider-example/fixture-recipes";
      const material = "org/provider-example/fixture-sources";
      const result = await runFixture([caseId, recipe, material]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "Spack artifact export and import regression: status=succeeded",
      );
      expect(result.trace).toContain(
        `export-arguments: export /opt/kq-case /out/delivery ${caseId} ${recipe} ${material}`,
      );
      expect(result.trace).toContain(`case=${caseId}`);
      expect(result.trace).not.toMatch(/production-must-not-touch|inherited-must-not-use/);
      expect(result.trace).not.toMatch(/\b(prune|logs|inspect|push|upload-artifact)\b/);
      expect(result.trace).not.toContain("build scheduler");
      expect(result.trace).not.toContain("exec -T");
      expect(result.trace).toContain("--env-file /dev/null");
      const lines = result.trace.trim().split("\n");
      expect(lines.filter((line) => line.startsWith("store-generation="))).toEqual([
        "store-generation=1",
        "store-generation=1",
        "store-generation=2",
        "store-generation=2",
      ]);
      const verifies = lines.filter((line) =>
        line.startsWith("bun deploy/pr-test/spack-artifacts/verify.ts"),
      );
      expect(verifies.map((line) => line.split(" | ")[0]?.split(" ").at(-1))).toEqual([
        "bootstrap",
        "bootstrap-restart",
        "empty",
        "web",
        "web-restart",
      ]);
      const destroy = result.trace.indexOf("down --volumes --remove-orphans --timeout 15");
      expect(destroy).toBeGreaterThan(result.trace.indexOf("verify.ts bootstrap-restart"));
      expect(destroy).toBeLessThan(result.trace.indexOf("verify.ts empty"));
      expect(result.trace.indexOf("verify.ts empty")).toBeLessThan(
        result.trace.indexOf("bun run --cwd"),
      );
      const starts = lines.filter((line) => line.includes(" up "));
      expect(starts).toHaveLength(4);
      expect(starts.every((line) => line.includes("300 server registry |"))).toBe(true);
      expect(lines.filter((line) => line.startsWith("export-arguments: "))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("docker cp "))).toHaveLength(1);
      const projects = [...result.trace.matchAll(/ -p (kq-material-artifact-[a-f0-9]{16}) /g)];
      expect(projects.length).toBeGreaterThan(5);
      expect(new Set(projects.map((match) => match[1])).size).toBe(1);
      expect(await readdir(result.runnerTemp)).toEqual(["kq-spack-material-artifact"]);
      expect((await readdir(result.output)).sort()).toEqual([
        "README.md",
        "checksums.txt",
        "material-pack",
        "provenance.json",
        "recipe-pack",
      ]);
      expect((await readdir(join(result.output, "recipe-pack"))).sort()).toEqual([
        "manifest.json",
        "recipes.bundle",
      ]);
      expect((await readdir(join(result.output, "material-pack"))).sort()).toEqual([
        "blobs",
        "manifest.json",
      ]);
      expect(result.trace).toContain("down --volumes --remove-orphans --rmi local --timeout 15");
    }, 15_000);
  }

  const failureStages = [
    "config",
    "build",
    "export",
    "copy",
    "up",
    "listener",
    "bootstrap",
    "bootstrap-restart",
    "empty",
    "browser",
    "web",
    "web-restart",
    "checksum",
    "down",
  ];
  for (const failure of failureStages) {
    test(`${failure} failure cleans up without success`, async () => {
      const result = await runFixture(undefined, failure);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain(
        "Spack artifact export and import regression: status=succeeded",
      );
      expect(result.trace).toContain("docker rm -f kq-material-artifact-");
      expect(result.trace).toContain("down --volumes --remove-orphans --rmi local --timeout 15");
      expect(await readdir(result.runnerTemp)).toEqual([]);
      const phases = ["bootstrap", "bootstrap-restart", "empty", "web", "web-restart"];
      const index = phases.indexOf(failure);
      if (index >= 0) {
        for (const phase of phases.slice(index + 1)) {
          expect(result.trace).not.toContain(`verify.ts ${phase} |`);
        }
      }
      if (failure === "browser") expect(result.trace).not.toContain("verify.ts web |");
    }, 15_000);
  }

  test("final cleanup failure fails the step even after the output was prepared", async () => {
    const result = await runFixture(undefined, "cleanup");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Spack artifact cleanup: status=failed");
    expect(result.trace).toContain("docker rm -f kq-material-artifact-");
    expect(result.trace).toContain("down --volumes --remove-orphans --rmi local --timeout 15");
    expect(result.trace).toContain("docker image rm kq-material-artifact-");
    expect(await readdir(result.runnerTemp)).toEqual(["kq-spack-material-artifact"]);
  }, 15_000);
});
