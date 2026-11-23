import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteRuntimePayloadSchema } from "../software-governance";
import { wrapCommand, wrapSiteRuntime } from "./wrap-command";

describe("wrapCommand — facility wrapping to a shell command string", () => {
  test("Spack: evaluates non-interactive shell activation before the command", () => {
    expect(
      wrapCommand({
        facility: { kind: "Spack", name: "openfoam", argumentList: [] },
        argv: ["simpleFoam", "-endTime", "500"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe('eval "$(spack load --sh openfoam)" && simpleFoam -endTime 500');
  });

  test("Spack: passes the spec argumentList through unquoted", () => {
    expect(
      wrapCommand({
        facility: { kind: "Spack", name: "openfoam", argumentList: ["+mpi", "%gcc"] },
        argv: ["x"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe('eval "$(spack load --sh openfoam +mpi %gcc)" && x');
  });

  test("shell-quotes an argv value containing spaces", () => {
    expect(
      wrapCommand({
        facility: { kind: "Spack", name: "of", argumentList: [] },
        argv: ["x", "--label", "hello world"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe("eval \"$(spack load --sh of)\" && x --label 'hello world'");
  });

  test("escapes an embedded single quote", () => {
    expect(
      wrapCommand({
        facility: { kind: "Spack", name: "of", argumentList: [] },
        argv: ["echo", "it's"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe("eval \"$(spack load --sh of)\" && echo 'it'\\''s'");
  });

  test("shell-quotes a frozen Spack spec token containing control characters", () => {
    expect(
      wrapCommand({
        facility: { kind: "Spack", name: "zlib; touch /tmp/pwned", argumentList: [] },
        argv: ["true"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe("eval \"$(spack load --sh 'zlib; touch /tmp/pwned')\" && true");
  });

  test("Bare: runs the command directly (no env-activation prefix)", () => {
    expect(
      wrapCommand({
        facility: { kind: "Bare" },
        argv: ["hostname"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe("hostname");
  });

  test("Singularity: wraps with apptainer exec <image>:<tag>", () => {
    expect(
      wrapCommand({
        facility: { kind: "Singularity", image: "openfoam", tag: "v2312" },
        argv: ["simpleFoam", "-help"],
        envVars: {},
        inputStaging: [],
        expectedOutputs: [],
      }),
    ).toBe("apptainer exec openfoam:v2312 simpleFoam -help");
  });
});

test("a frozen Bare executable uses verified bytes, application argv and environment", async () => {
  const path = "/usr/bin/printf";
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
  const task = {
    facility: { kind: "Bare" as const },
    argv: ["printf", "%s", "two words"],
    envVars: { PATH: "/unused" },
    inputStaging: [],
    expectedOutputs: [],
  };
  const runtime = { kind: "Bare" as const, path, sha256 };
  const execute = (digest: string) => {
    const { command, envVars } = wrapSiteRuntime(task, { ...runtime, sha256: digest });
    expect(envVars).toEqual({ KQ_SITE_ENV_PATH: "/unused" });
    return Bun.spawnSync(["/bin/sh", "-c", command], { env: envVars });
  };
  expect(execute(sha256).stdout.toString()).toBe("two words");
  expect(execute("0".repeat(64)).exitCode).not.toBe(0);
  expect(() => wrapSiteRuntime({ ...task, argv: ["other"] }, runtime)).toThrow("differs");
});

test("a frozen SIF invocation uses its signed path and passes application env into the container", () => {
  const facility = { kind: "Singularity" as const, image: "solver", tag: "1" };
  const runtime = { ...facility, path: "/opt/solver.sif", sha256: "1".repeat(64) };
  const task = {
    facility,
    argv: ["run", "sample input"],
    envVars: { LABEL: "sample value" },
    inputStaging: [],
    expectedOutputs: [],
  };
  const { command, envVars } = wrapSiteRuntime(task, runtime);
  expect(command).toContain(
    "APPTAINERENV_LABEL=\"$KQ_SITE_ENV_LABEL\" /usr/bin/apptainer exec --cleanenv --no-eval /opt/solver.sif run 'sample input'",
  );
  expect(envVars).toEqual({ KQ_SITE_ENV_LABEL: "sample value" });
  expect(() => wrapSiteRuntime(task, { ...runtime, tag: "2" })).toThrow("differs");
});

test("site paths with spaces and quotes keep stdin and app environment values intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kq-site-"));
  try {
    const path = join(dir, "本地 solver's script");
    const source = '#!/bin/sh\nread -r line\nprintf "%s:%s" "$LABEL" "$line"\nexit 7\n';
    await writeFile(path, source);
    await chmod(path, 0o755);
    const runtime = SiteRuntimePayloadSchema.parse({
      kind: "site-runtime",
      siteIds: ["site-a"],
      runtime: {
        kind: "Bare",
        path,
        sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
      },
    }).runtime;
    const job = wrapSiteRuntime(
      {
        facility: { kind: "Bare" },
        argv: [path],
        envVars: { LABEL: "a 'quoted' value" },
        inputStaging: [],
        expectedOutputs: [],
      },
      runtime,
    );
    const result = Bun.spawnSync(["/bin/sh", "-c", job.command], {
      env: job.envVars,
      stdin: Buffer.from("from stdin\n"),
    });
    expect(result.stdout.toString()).toBe("a 'quoted' value:from stdin");
    expect(result.exitCode).toBe(7);
    await writeFile(path, `${source}# changed\n`);
    const changed = Bun.spawnSync(["/bin/sh", "-c", job.command], { env: job.envVars });
    expect(changed.exitCode).toBe(1);
    expect(changed.stdout.toString()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
