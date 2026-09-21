import "./pr-scheduler-entrypoint.test";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { queueInventoryReady, schedulerCancelled, waitFor } from "../deploy/pr-test/runtime";
import {
  managedQueueMarker,
  nativeQueueMarker,
} from "../deploy/pr-test/spack-managed/queue-diagnostic";
import { loadServerConfig } from "../packages/server/src/config";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const compose = parse(
  await readFile(join(root, "deploy/compose/docker-compose.pr-test.yml"), "utf8"),
) as {
  services: Record<
    string,
    {
      build?: { dockerfile: string; args?: Record<string, string>; additional_contexts?: object };
      environment?: Record<string, string>;
      networks?: string[];
      ports?: unknown;
      volumes?: string[];
      privileged?: string;
      container_name?: string;
      network_mode?: string;
      read_only?: boolean;
      cap_drop?: string[];
      security_opt?: string[];
    }
  >;
  networks: Record<string, { internal: boolean }>;
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PR scheduler isolation contract", () => {
  test("keeps legacy inventory diagnosis bounded and free of raw output", async () => {
    const child = Bun.spawn({
      cmd: [
        "python3",
        "-I",
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        ".",
        "-p",
        "test_legacy_probe.py",
        "-v",
      ],
      cwd: join(root, "deploy/pr-test/spack-managed"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toMatchObject({
      exitCode: 0,
      stdout: "",
      stderr: expect.stringContaining("OK"),
    });
    expect(stderr).toMatch(/Ran [1-9]\d* tests? in/);
  }, 30_000);

  test("keeps managed phase diagnostics bounded and preserves worker behavior", async () => {
    const child = Bun.spawn({
      cmd: [
        "python3",
        "-I",
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        ".",
        "-p",
        "test_diagnostic.py",
        "-v",
      ],
      cwd: join(root, "deploy/pr-test/spack-managed"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toMatchObject({
      exitCode: 0,
      stdout: "",
      stderr: expect.stringContaining("OK"),
    });
    expect(stderr).toMatch(/Ran [1-9]\d* tests? in/);
  }, 30_000);

  test("prepares pinned recipe metadata without the GitHub tree API", async () => {
    const child = Bun.spawn({
      cmd: [
        "python3",
        "-I",
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        ".",
        "-p",
        "test_prepare.py",
        "-v",
      ],
      cwd: join(root, "deploy/pr-test/spack-case"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toMatchObject({
      exitCode: 0,
      stdout: "",
      stderr: expect.stringContaining("OK"),
    });
  }, 30_000);

  test("provides all required Server configuration without optional infrastructure", () => {
    const env = {
      ...compose.services.server?.environment,
      DATABASE_URL: "postgres://fixture:fixture@postgres:5432/kuintessence",
      JWT_SECRET: "fixture-pr-jwt-secret-not-for-production",
    };
    expect(loadServerConfig(env)).toMatchObject({
      REDIS_URL: "redis://unused:6379",
      AUTHZ_MODE: "off",
      MTLS_MODE: "off",
      NETDRIVE_ENABLED: false,
      SSO_BOOTSTRAP_ENABLED: false,
    });
  });

  test("uses Bun for Node shebangs at generation time and includes operation idempotency", async () => {
    const dockerfile = await readFile(join(root, "deploy/pr-test/workspace.Dockerfile"), "utf8");
    expect(dockerfile).toContain("bun --bun run --filter @kuintessence/proto generate");
    const runtime = await readFile(join(root, "deploy/pr-test/runtime.ts"), "utf8");
    expect(runtime).toContain('"Idempotency-Key": randomUUID()');
  });

  test("pins Spack only in PR and builds scheduler layers from the shared base", () => {
    expect(compose.services["scheduler-base"]?.build?.args?.SPACK_REF).toBe("v1.0.0");
    expect(compose.services["scheduler-runtime"]?.build?.additional_contexts).toEqual({
      "scheduler-base": "service:scheduler-base",
    });
    expect(compose.services.scheduler?.build?.additional_contexts).toEqual({
      "scheduler-runtime": "service:scheduler-runtime",
      "test-workspace": "service:test-workspace",
    });
  });

  test("does not expose ports, fixed container names, host mounts or external runtime networks", () => {
    for (const service of Object.values(compose.services)) {
      expect(service.ports).toBeUndefined();
      expect(service.container_name).toBeUndefined();
      for (const volume of service.volumes ?? []) {
        expect(volume.split(":")[0]).toMatch(/^[a-z-]+$/);
      }
    }
    expect(Object.values(compose.networks).every((network) => network.internal)).toBe(true);
    expect(compose.services.scheduler?.networks).toEqual(["control"]);
    expect(compose.services.registry?.networks).toEqual(["backend"]);
    expect(compose.services.server?.networks).toEqual(["backend", "control"]);
    expect(compose.services.scheduler?.privileged).toBe(`\${KQ_PR_PRIVILEGED:-false}`);
  });

  test("persists recipes and sources separately and never enables unconfigured installation", () => {
    const registry = compose.services.registry;
    expect(registry?.environment?.SPACK_RECIPE_STORE_DIR).toBe(
      "/var/lib/kuintessence/registry/recipes",
    );
    expect(registry?.environment?.SPACK_MATERIAL_STORE_DIR).toBe(
      "/var/lib/kuintessence/registry/materials",
    );
    expect(registry?.volumes).toContain("registry-data:/var/lib/kuintessence/registry");
    expect(compose.services.scheduler?.environment?.AGENT_SPACK_INSTALL_ENABLED).toBe("false");
    expect(compose.services.server?.environment?.SPACK_MATERIAL_DELIVERY_ENABLED).toBe("false");
  });
});

async function runWithFakeDocker(
  args: string[],
  failure:
    | "none"
    | "info"
    | "build"
    | "up"
    | "exec"
    | "down"
    | "rollout-activate"
    | "rollout-verify"
    | "epoch" = "none",
  githubActions = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "kq-pr-compose-test-"));
  temporary.push(dir);
  const docker = join(dir, "docker");
  const log = join(dir, "commands");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -eu
printf '%s | epoch=%s case=%s\\n' "$*" "\${KQ_PR_MATERIAL_EPOCH-unset}" "\${KQ_PR_SPACK_CASE-unset}" >> "$PR_COMMAND_LOG"
case " $* " in
  *" info "*) [[ "$PR_FAIL" != info ]] || exit 9 ;;
  *" build scheduler "*) [[ "$PR_FAIL" != build ]] || exit 19 ;;
  *" up "*) [[ "$PR_FAIL" != up ]] || exit 17 ;;
  *" exec "*) [[ "$PR_FAIL" != exec ]] || exit 23 ;;
  *" down "*) [[ "$PR_FAIL" != down ]] || exit 21 ;;
esac
case " $* " in
  *" logs --no-color --no-log-prefix --tail 200 scheduler "*)
    printf '%s\\n' \
      'fixture-private-registration-token' \
      'ci-pbs-entrypoint:event=ERR line=31 exit=1' \
      'ci-pbs-entrypoint:event=EXIT line=31 exit=1' \
      'ci-pbs-entrypoint:event=ERR line=31 exit=1 fixture-private-registration-token' \
      'ci-pbs-entrypoint:event=ERR line=100000 exit=1' \
      'ci-pbs-entrypoint:event=ERR line=31 exit=256'
    printf '%s\\n' 'fixture-private-docker-error' >&2 ;;
  *" deploy/pr-test/spack-case/rollout.ts activate "*)
    [[ "$PR_FAIL" != rollout-activate ]] || exit 29
    if [[ "$PR_FAIL" == epoch ]]; then printf 'invalid-epoch\\n'
    else printf '12345678-abcd-4123-8123-123456789abc\\n'; fi ;;
  *" deploy/pr-test/spack-case/rollout.ts verify "*) [[ "$PR_FAIL" != rollout-verify ]] || exit 31 ;;
esac
`,
  );
  await chmod(docker, 0o755);
  const result = Bun.spawn({
    cmd: ["bash", join(root, "deploy/pr-test/run.sh"), ...args],
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PR_COMMAND_LOG: log,
      PR_FAIL: failure,
      COMPOSE_PROJECT_NAME: "production-must-not-touch",
      COMPOSE_FILE: "/do-not-use.yml",
      COMPOSE_PROFILES: "tunnel",
      KQ_PR_MATERIAL_EPOCH: "inherited-must-not-use",
      KQ_PR_SPACK_CASE: "inherited-must-not-use",
      GITHUB_ACTIONS: String(githubActions),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  const commands = await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { code, stdout, stderr, commands };
}

describe("PR runner lifecycle (fake Docker, no containers)", () => {
  test("PBS startup failure retains its exit and exposes only bounded entrypoint markers", async () => {
    const result = await runWithFakeDocker(["pbs"], "up");
    expect(result.code).toBe(17);
    expect(result.commands).toContain("logs --no-color --no-log-prefix --tail 200 scheduler");
    expect(result.commands).not.toContain("exec -T --user kq scheduler timeout");
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    const markers = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("ci-pbs-entrypoint:"));
    expect(markers).toEqual([
      "ci-pbs-entrypoint:event=ERR line=31 exit=1",
      "ci-pbs-entrypoint:event=EXIT line=31 exit=1",
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain("fixture-private");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
  });

  test("config only does not access daemon, build, start or delete anything", async () => {
    const result = await runWithFakeDocker(["slurm", "--config"]);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("--env-file /dev/null");
    expect(result.commands).toContain("config --quiet");
    expect(result.commands).not.toMatch(/\b(info|build|up|exec|down)\b/);
    expect(result.commands).not.toContain("production-must-not-touch");
  });

  test("rejects unsupported schedulers and flags before invoking Docker", async () => {
    for (const args of [["k3s"], ["slurm", "--production"]]) {
      const result = await runWithFakeDocker(args);
      expect(result.code).toBe(2);
      expect(result.commands).toBe("");
    }
  });

  test("unavailable daemon fails without building or cleaning unrelated resources", async () => {
    const result = await runWithFakeDocker(["pbs"], "info");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no build or tests ran");
    expect(result.commands).not.toMatch(/\b(build|up|exec|down)\b/);
  });

  test("successful run builds before startup, tests as kq, and removes only its project", async () => {
    const result = await runWithFakeDocker(["pbs"]);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("--profile images build scheduler");
    expect(result.commands).toContain(
      "up -d --no-build --wait --wait-timeout 300 scheduler registry",
    );
    expect(result.commands).toContain("exec -T --user kq scheduler timeout");
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.commands).not.toContain("production-must-not-touch");
    expect(result.commands).not.toMatch(/\b(prune|logs)\b/);
    const projectCommands = result.commands.split("\n").filter((line) => line.includes(" -p "));
    expect(projectCommands.every((line) => line.includes(" --profile images "))).toBe(true);
    const projects = [...result.commands.matchAll(/-p (kq-pr-test-pbs-[a-f0-9]{16})/g)];
    expect(projects.length).toBeGreaterThan(3);
    expect(new Set(projects.map((match) => match[1])).size).toBe(1);
  });

  test("Spack case provisions TLS and publishes before Agent startup, then checks persistence", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-case"]);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("docker-compose.pr-spack-case.yml");
    expect(result.commands).toContain("build case-operator");
    expect(result.commands).toContain("run --rm --no-deps case-operator bun");
    expect(result.commands.indexOf("spack-case/setup.ts")).toBeLessThan(
      result.commands.indexOf("spack-case/publish.ts"),
    );
    expect(result.commands.indexOf("spack-case/publish.ts")).toBeLessThan(
      result.commands.indexOf("up -d --no-build --wait --wait-timeout 300 scheduler registry"),
    );
    expect(result.commands).toContain("spack-case/consume.ts");
    expect(result.commands).toContain("exec -T --user kq scheduler timeout");
    expect(result.commands).toContain("restart registry scheduler");
    expect(result.commands).toContain("spack-case/publish.ts --verify");
    expect(result.commands).toContain("spack-case/job.ts");
    expect(result.commands).not.toMatch(/\b(prune|logs)\b/);
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
  });

  test("does not silently claim PBS Spack case coverage", async () => {
    const result = await runWithFakeDocker(["pbs", "--spack-case"]);
    expect(result.code).toBe(2);
    expect(result.commands).toBe("");
  });

  test("rollout runs after Hello and adopts only its validated epoch for recreation", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-case"]);
    expect(result.code).toBe(0);
    expect(result.commands).not.toContain("inherited-must-not-use");
    expect(result.commands.indexOf("rollout.ts activate")).toBeGreaterThan(
      result.commands.lastIndexOf("spack-case/job.ts"),
    );
    const commands = result.commands.split("\n");
    expect(commands.find((line) => line.includes("rollout.ts activate"))).toContain("epoch=unset");
    const recreate = commands.find((line) => line.includes("up -d --force-recreate"));
    expect(recreate).toContain("server registry");
    expect(recreate).toContain("epoch=12345678-abcd-4123-8123-123456789abc");
    expect(result.commands.indexOf("rollout.ts verify")).toBeGreaterThan(
      result.commands.indexOf("up -d --force-recreate"),
    );
  });

  test.each([
    "rollout-activate",
    "epoch",
    "rollout-verify",
  ] as const)("rollout failure %s preserves cleanup and cannot report success", async (failure) => {
    const result = await runWithFakeDocker(["slurm", "--spack-case"], failure);
    expect(result.code).not.toBe(0);
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.stdout).not.toContain("PR scheduler and material regression passed");
    if (failure !== "rollout-verify") {
      expect(result.commands).not.toContain("up -d --force-recreate");
      expect(result.commands).not.toContain("rollout.ts verify");
    }
  });

  test("managed case refuses local execution before invoking Docker", async () => {
    for (const flag of ["--spack-managed", "--spack-samtools"]) {
      const result = await runWithFakeDocker(["slurm", flag]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("only on disposable GitHub Actions runners");
      expect(result.commands).toBe("");
    }
  });

  test("samtools requires Slurm and cannot claim PBS coverage", async () => {
    const result = await runWithFakeDocker(["pbs", "--spack-samtools"], "none", true);
    expect(result.code).toBe(2);
    expect(result.commands).toBe("");
  });

  test("samtools uses the managed lifecycle with an explicit case and rollout", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-samtools"], "none", true);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("case=samtools");
    expect(result.commands).not.toContain("case=hello");
    expect(result.commands).not.toContain("inherited-must-not-use");
    expect(result.commands).toContain("docker-compose.pr-spack-managed.yml");
    expect(result.commands).toContain("spack-managed/case.ts install");
    expect(result.commands).toContain("spack-managed/case.ts restart");
    expect(result.commands).toContain("spack-managed/case.ts uninstall");
    expect(result.commands).toContain("spack-case/publish.ts --verify");
    expect(result.commands).toContain("rollout.ts verify");
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.commands).not.toContain("spack-case/consume.ts");
    expect(result.commands).not.toContain("spack-case/check.sh");
  });

  test("managed lifecycle verifies real runtime before API install and cleans its project", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-managed"], "none", true);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("docker-compose.pr-spack-managed.yml");
    expect(result.commands).toContain("build case-operator managed-builder");
    expect(result.commands).toContain(
      "exec -T --user kq scheduler head -c 512 /var/lib/kuintessence/legacy-probe-status",
    );
    expect(result.commands).toContain("--entrypoint chmod managed-builder 0444 /runtime/spack.sif");
    expect(result.commands.indexOf("spack-managed/probe.ts")).toBeLessThan(
      result.commands.indexOf("spack-managed/case.ts install"),
    );
    expect(result.commands).toContain("spack-managed/case.ts restart");
    expect(result.commands).toContain("spack-managed/case.ts uninstall");
    expect(result.commands).toContain("spack-case/publish.ts --verify");
    expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    expect(result.commands).not.toContain("spack-case/consume.ts");
    expect(result.commands).not.toContain("spack-case/check.sh");
    expect(result.commands).not.toMatch(/\b(prune|logs)\b/);
    expect(result.commands).not.toContain("production-must-not-touch");
    expect(result.commands).toContain("case=hello");
    expect(result.commands).not.toContain("inherited-must-not-use");
  });

  test("managed overlay is opt-in with private cgroups and no host runtime mounts", async () => {
    const overlay = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-spack-managed.yml"), "utf8"),
    ) as typeof compose & {
      services: Record<string, { cgroup?: string }>;
    };
    const scheduler = overlay.services.scheduler;
    expect(scheduler?.cgroup).toBe("private");
    expect(scheduler?.environment?.AGENT_SPACK_INSTALL_ENABLED).toBe("true");
    expect(scheduler?.environment?.AGENT_SPACK_AUDIT_ENABLED).toBe("true");
    expect(scheduler?.volumes).toContain("managed-runtime:/opt/kq/runtime:ro");
    expect(overlay.services["managed-builder"]?.network_mode).toBe("none");
    for (const service of Object.values(overlay.services)) {
      expect(service.ports).toBeUndefined();
      expect(service.network_mode).not.toBe("host");
      for (const volume of service.volumes ?? []) {
        expect(volume.split(":")[0]).toMatch(/^[a-z-]+$/);
      }
    }
    const dockerfile = await readFile(
      join(root, "deploy/pr-test/spack-managed/runtime.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("sha256sum --check");
    expect(dockerfile).toContain("rm /etc/sudoers.d/kq");
    expect(dockerfile).toContain("gpasswd -d kq sudo");
    const legacyLock = "/opt/spack/opt/spack/.spack-db/lock";
    const lockSetup = `touch ${legacyLock}`;
    expect(dockerfile.indexOf(lockSetup)).toBeGreaterThan(
      dockerfile.indexOf("FROM managed-base AS scheduler"),
    );
    expect(dockerfile).toContain(`chown root:root ${legacyLock}`);
    expect(dockerfile).toContain(`chmod 0644 ${legacyLock}`);
    expect(dockerfile).toContain(`runuser -u kq -- test -r ${legacyLock}`);
    expect(dockerfile).toContain(`! runuser -u kq -- test -w ${legacyLock}`);
    expect(dockerfile).toContain("! runuser -u kq -- test -w /opt/spack/opt/spack/.spack-db");
    expect(dockerfile).not.toContain("chown -R kq");
    expect(dockerfile).not.toContain("index.json");
    const probe = await readFile(join(root, "deploy/pr-test/spack-managed/probe.py"), "utf8");
    expect(probe).toContain("boundary.verify_runtime_boundary");
    const profile = await readFile(
      join(root, "deploy/pr-test/spack-managed/apparmor.profile"),
      "utf8",
    );
    expect(profile).toContain("/usr/libexec/apptainer/bin/starter flags=(unconfined)");
    expect(profile).toContain("userns,");
    expect(profile).not.toContain("starter-suid");
    const acceptance = await readFile(join(root, "deploy/pr-test/spack-managed/case.ts"), "utf8");
    expect(acceptance).toContain("process.getuid?.() === 1000");
    expect(acceptance).toContain("process.geteuid?.() === 1000");
    expect(acceptance).not.toContain('from "node:os"');
  });

  test("Spack overlay isolates private CA and inputs from Agent and keeps managed install off", async () => {
    const overlay = parse(
      await readFile(join(root, "deploy/compose/docker-compose.pr-spack-case.yml"), "utf8"),
    ) as typeof compose;
    expect(overlay.services.server?.environment?.MTLS_MODE).toBe("direct");
    expect(overlay.services.server?.environment?.SPACK_MATERIAL_DELIVERY_ENABLED).toBe("true");
    expect(overlay.services.scheduler?.environment?.AGENT_MTLS_REQUIRED).toBe("true");
    expect(overlay.services.scheduler?.environment?.SERVER_HTTP_URL).toBe("https://server:3443");
    expect(overlay.services.scheduler?.environment?.AGENT_SPACK_INSTALL_ENABLED).toBeUndefined();
    expect(overlay.services.scheduler?.environment?.SPACK_REGISTRY_JWT_SECRET).toBeUndefined();
    expect(overlay.services.scheduler?.volumes).not.toContain("case-server:/case-server:ro");
    expect(overlay.services["case-operator"]?.networks).toEqual(["backend"]);
    expect(overlay.services["case-operator"]?.build?.args?.KQ_PR_SPACK_CASE).toBe(
      "${KQ_PR_SPACK_CASE:-hello}",
    );
    for (const service of ["case-operator", "server", "scheduler"]) {
      expect(overlay.services[service]?.environment?.KQ_PR_SPACK_CASE).toBe(
        "${KQ_PR_SPACK_CASE:-hello}",
      );
    }
    expect(overlay.services["case-native"]?.network_mode).toBe("none");
    expect(overlay.services["case-native"]?.read_only).toBe(true);
    expect(overlay.services["case-native"]?.cap_drop).toEqual(["ALL"]);
    expect(overlay.services["case-native"]?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(overlay.services["case-native"]?.volumes).toEqual([
      "scratch:/scratch",
      "case-input:/case-input:ro",
    ]);
    for (const service of Object.values(overlay.services)) {
      expect(service.ports).toBeUndefined();
    }
  });

  for (const [failure, code] of [
    ["build", 19],
    ["up", 17],
    ["exec", 23],
    ["down", 1],
  ] as const) {
    test(`${failure} failure remains nonzero and cleanup runs`, async () => {
      const result = await runWithFakeDocker(["slurm"], failure);
      expect(result.code).toBe(code);
      expect(result.commands).toContain("down --volumes --remove-orphans --rmi local");
    });
  }
});

describe("runtime assertions", () => {
  test("managed queue diagnostics expose only validated enums and booleans", () => {
    const inventory = {
      agentId: "private-agent",
      providerOrgId: null,
      schedulerType: "slurm",
      queueInventoryV1: true,
      status: "available",
      defaultQueueName: "debug",
      reason: null,
      observedAt: "2026-01-01T00:00:00.000Z",
      queues: [
        {
          queueName: "debug",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt: "2026-01-01T00:00:00.000Z",
          managed: false,
          managedQueueIds: [],
        },
      ],
    };
    expect(managedQueueMarker(inventory)).toBe(
      "ci-managed-queue:capable=true status=available reason=none target=up accepting=true attempt-age=missing observation-age=missing no-go=unavailable recovering=unavailable recovered=unavailable",
    );
    expect(
      managedQueueMarker({
        ...inventory,
        status: "unavailable",
        reason: "command_failed",
        queues: [],
      }),
    ).toBe(
      "ci-managed-queue:capable=true status=unavailable reason=command_failed target=missing accepting=false attempt-age=missing observation-age=missing no-go=unavailable recovering=unavailable recovered=unavailable",
    );
    const recovery = {
      ...inventory,
      lastAttemptAt: inventory.observedAt,
      lastSuccessfulObservedAt: inventory.observedAt,
      lastNoGoAt: inventory.observedAt,
      recoveryStartedAt: inventory.observedAt,
      recoveredAt: null,
    };
    const observedAt = Date.parse(inventory.observedAt);
    for (const [elapsed, bucket] of [
      [-1, "future"],
      [120_000, "under-120s"],
      [120_001, "120-240s"],
      [240_001, "over-240s"],
    ] as const) {
      const marker = managedQueueMarker(recovery, observedAt + elapsed);
      expect(marker).toContain(`attempt-age=${bucket} observation-age=${bucket}`);
      expect(marker).toContain("no-go=present recovering=present recovered=absent");
      expect(marker).not.toContain("private-agent");
      expect(marker).not.toContain(inventory.observedAt);
    }
    expect(() => managedQueueMarker({ ...inventory, reason: "private-error" })).toThrow();
    expect(
      nativeQueueMarker({
        status: "unavailable",
        reason: "command_failed",
        observedAt: new Date(),
        queues: [],
      }),
    ).toBe(
      "ci-managed-queue-native:status=unavailable reason=command_failed target=missing accepting=false",
    );
    expect(() => nativeQueueMarker({ status: "private-error" })).toThrow();
  });

  test("waits for reported, available inventory and an accepting target queue", () => {
    const snapshot = {
      agentId: "pr-scheduler",
      providerOrgId: null,
      schedulerType: "slurm",
      queueInventoryV1: true,
      status: "available",
      defaultQueueName: "debug",
      reason: null,
      observedAt: "2026-01-01T00:00:00.000Z",
      queues: [
        {
          queueName: "debug",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt: "2026-01-01T00:00:00.000Z",
          managed: false,
          managedQueueIds: [],
        },
      ],
    };
    expect(queueInventoryReady(snapshot, "debug")).toBe(true);
    const pending = { ...snapshot, status: "unknown", queues: [] };
    expect(queueInventoryReady(pending, "debug")).toBe(false);
    expect(queueInventoryReady({ ...snapshot, queueInventoryV1: false }, "debug")).toBe(false);
    expect(queueInventoryReady({ ...snapshot, status: "stale" }, "debug")).toBe(false);
    expect(queueInventoryReady(snapshot, "missing")).toBe(false);
    for (const change of [{ state: "down" }, { acceptsSubmissions: false }]) {
      expect(
        queueInventoryReady(
          { ...snapshot, queues: [{ ...snapshot.queues[0], ...change }] },
          "debug",
        ),
      ).toBe(false);
    }
  });

  test("requires native cancellation, not just an absent or failed qstat response", () => {
    expect(schedulerCancelled("slurm", "JobState=RUNNING")).toBe(false);
    expect(schedulerCancelled("slurm", "JobState=CANCELLED Reason=None")).toBe(true);
    expect(schedulerCancelled("pbs", JSON.stringify({ Jobs: {} }))).toBe(false);
    expect(
      schedulerCancelled("pbs", JSON.stringify({ Jobs: { "1.scheduler": { job_state: "F" } } })),
    ).toBe(false);
    expect(
      schedulerCancelled(
        "pbs",
        JSON.stringify({ Jobs: { "1.scheduler": { job_state: "F", Exit_status: 271 } } }),
      ),
    ).toBe(true);
    expect(() => schedulerCancelled("pbs", "connection failed")).toThrow();
  });

  test("polling propagates request errors instead of treating an outage as readiness", async () => {
    await expect(
      waitFor(
        "fixture",
        async () => {
          throw new Error("request failed");
        },
        Boolean,
      ),
    ).rejects.toThrow("request failed");
    expect(await waitFor("fixture", async () => true, Boolean)).toBe(true);
  });
});
