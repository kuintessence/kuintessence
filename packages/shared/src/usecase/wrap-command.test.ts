import { describe, expect, test } from "bun:test";
import { wrapCommand } from "./wrap-command";

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
