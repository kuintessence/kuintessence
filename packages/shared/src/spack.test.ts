import { describe, expect, test } from "bun:test";
import {
  decideSpackPolicy,
  InstalledSpecSchema,
  MirrorSpecSchema,
  matchesSpecPattern,
  SpackPolicySchema,
  SpecPatternSchema,
} from "./spack";

describe("InstalledSpecSchema", () => {
  test("accepts a minimal spec", () => {
    const parsed = InstalledSpecSchema.parse({
      name: "gromacs",
      version: "2024.1",
      hash: "abc123",
      spec: "gromacs@2024.1",
    });
    expect(parsed.name).toBe("gromacs");
    expect(parsed.compiler).toBeUndefined();
  });

  test("accepts optional compiler/arch", () => {
    const parsed = InstalledSpecSchema.parse({
      name: "gromacs",
      version: "2024.1",
      hash: "abc123",
      spec: "gromacs@2024.1%gcc@13.2.0",
      compiler: "gcc@13.2.0",
      arch: "linux-rocky9-x86_64",
    });
    expect(parsed.compiler).toBe("gcc@13.2.0");
    expect(parsed.arch).toBe("linux-rocky9-x86_64");
  });

  test("rejects empty name", () => {
    expect(() =>
      InstalledSpecSchema.parse({ name: "", version: "1", hash: "h", spec: "x@1" }),
    ).toThrow();
  });
});

describe("SpecPatternSchema", () => {
  test("accepts non-empty string", () => {
    expect(SpecPatternSchema.parse("gromacs@*")).toBe("gromacs@*");
  });

  test("rejects empty string", () => {
    expect(() => SpecPatternSchema.parse("")).toThrow();
  });
});

describe("matchesSpecPattern", () => {
  test("matches exact, wildcard, and reduced spec heads", () => {
    expect(matchesSpecPattern("gromacs@2024.1", "gromacs@2024.1")).toBe(true);
    expect(matchesSpecPattern("gromacs@2024.1+mpi%gcc@13.2.0", "gromacs@2024.1")).toBe(true);
    expect(matchesSpecPattern("gromacs@2024.1 +mpi cuda_arch=80 %gcc@13.2.0", "gromacs@*")).toBe(
      true,
    );
    expect(matchesSpecPattern("gromacs@2024.5", "gromacs@2024.*")).toBe(true);
    expect(matchesSpecPattern("lammps@2024.1", "gromacs@*")).toBe(false);
  });

  test("matches bare package names against full Spack specs", () => {
    expect(matchesSpecPattern("gromacs@2024.1 +mpi", "gromacs")).toBe(true);
    expect(matchesSpecPattern("gromacs@2024.1 +mpi", "gromacs*")).toBe(true);
    expect(matchesSpecPattern("gromacs-gpu@2024.1", "gromacs")).toBe(false);
  });

  test("escapes non-wildcard regex characters", () => {
    expect(matchesSpecPattern("gromacs@2024X1", "gromacs@2024.1")).toBe(false);
  });
});

describe("SpackPolicySchema", () => {
  test("defaults lockEnabled to false when missing", () => {
    const parsed = SpackPolicySchema.parse({});
    expect(parsed.lockEnabled).toBe(false);
    expect(parsed.allowList).toBeUndefined();
    expect(parsed.denyList).toBeUndefined();
  });

  test("accepts full policy", () => {
    const parsed = SpackPolicySchema.parse({
      lockEnabled: true,
      allowList: ["gromacs@*", "openmpi@4.*"],
      denyList: ["*@2.0"],
    });
    expect(parsed.lockEnabled).toBe(true);
    expect(parsed.allowList).toEqual(["gromacs@*", "openmpi@4.*"]);
  });
});

describe("decideSpackPolicy", () => {
  test("allows unconstrained specs", () => {
    expect(decideSpackPolicy("gromacs@2024.1", { lockEnabled: false })).toBe("allow");
  });

  test("denyList wins before allowList", () => {
    const result = decideSpackPolicy("lammps@2024.1", {
      lockEnabled: true,
      allowList: ["lammps@*"],
      denyList: ["lammps@2024.*"],
    });
    expect(result).toEqual({ reject: "spec 'lammps@2024.1' matches denyList" });
  });

  test("uses bare package patterns for full Spack specs", () => {
    expect(
      decideSpackPolicy("gromacs@2024.1 +mpi cuda_arch=80", {
        lockEnabled: true,
        allowList: ["gromacs"],
      }),
    ).toBe("allow");
    const result = decideSpackPolicy("lammps@2024.1 +mpi", {
      lockEnabled: false,
      denyList: ["lammps"],
    });
    expect(result).toEqual({ reject: "spec 'lammps@2024.1' matches denyList" });
  });

  test("lock requires allowList match", () => {
    expect(
      decideSpackPolicy("gromacs@2024.1", {
        lockEnabled: true,
        allowList: ["gromacs@2024.*"],
      }),
    ).toBe("allow");
    const result = decideSpackPolicy("lammps@2024.1", {
      lockEnabled: true,
      allowList: ["gromacs@2024.*"],
    });
    expect(result).toEqual({
      reject: "spec 'lammps@2024.1' not in allowList while lock enabled",
    });
  });
});

describe("MirrorSpecSchema", () => {
  test("accepts minimal mirror", () => {
    const parsed = MirrorSpecSchema.parse({
      name: "internal",
      url: "https://mirrors.example.com/spack",
    });
    expect(parsed.priority).toBeUndefined();
  });

  test("accepts priority", () => {
    const parsed = MirrorSpecSchema.parse({
      name: "internal",
      url: "https://mirrors.example.com/spack",
      priority: 10,
    });
    expect(parsed.priority).toBe(10);
  });

  test("rejects empty url", () => {
    expect(() => MirrorSpecSchema.parse({ name: "x", url: "" })).toThrow();
  });
});
