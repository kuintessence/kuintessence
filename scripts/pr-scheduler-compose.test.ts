import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { queueInventoryReady, schedulerCancelled, waitFor } from "../deploy/pr-test/runtime";
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
  failure: "none" | "info" | "build" | "up" | "exec" | "down" = "none",
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
printf '%s\\n' "$*" >> "$PR_COMMAND_LOG"
case " $* " in
  *" info "*) [[ "$PR_FAIL" != info ]] || exit 9 ;;
  *" build scheduler "*) [[ "$PR_FAIL" != build ]] || exit 19 ;;
  *" up "*) [[ "$PR_FAIL" != up ]] || exit 17 ;;
  *" exec "*) [[ "$PR_FAIL" != exec ]] || exit 23 ;;
  *" down "*) [[ "$PR_FAIL" != down ]] || exit 21 ;;
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

  test("managed case refuses local execution before invoking Docker", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-managed"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("only on disposable GitHub Actions runners");
    expect(result.commands).toBe("");
  });

  test("managed lifecycle verifies real runtime before API install and cleans its project", async () => {
    const result = await runWithFakeDocker(["slurm", "--spack-managed"], "none", true);
    expect(result.code).toBe(0);
    expect(result.commands).toContain("docker-compose.pr-spack-managed.yml");
    expect(result.commands).toContain("build case-operator managed-builder");
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
    const probe = await readFile(join(root, "deploy/pr-test/spack-managed/probe.py"), "utf8");
    expect(probe).toContain("boundary.verify_runtime_boundary");
    const profile = await readFile(
      join(root, "deploy/pr-test/spack-managed/apparmor.profile"),
      "utf8",
    );
    expect(profile).toContain("/usr/libexec/apptainer/bin/starter flags=(unconfined)");
    expect(profile).toContain("userns,");
    expect(profile).not.toContain("starter-suid");
    const acceptance = await readFile(
      join(root, "deploy/pr-test/spack-managed/case.ts"),
      "utf8",
    );
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
