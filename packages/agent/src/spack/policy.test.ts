import { describe, expect, test } from "bun:test";
import type { SpackPolicy } from "@kuintessence/shared";
import { decidePolicy, matchesPattern } from "./policy";

describe("matchesPattern", () => {
  test("exact match", () => {
    expect(matchesPattern("gromacs@2024.1", "gromacs@2024.1")).toBe(true);
  });

  test("does not match different name", () => {
    expect(matchesPattern("gromacs@2024.1", "lammps@2024.1")).toBe(false);
  });

  test("does not match different version", () => {
    expect(matchesPattern("gromacs@2024.1", "gromacs@2024.2")).toBe(false);
  });

  test("trailing version wildcard", () => {
    expect(matchesPattern("gromacs@2024.1", "gromacs@*")).toBe(true);
    expect(matchesPattern("gromacs@2023.5", "gromacs@*")).toBe(true);
    expect(matchesPattern("lammps@2024.1", "gromacs@*")).toBe(false);
  });

  test("partial version wildcard like 2024.*", () => {
    expect(matchesPattern("gromacs@2024.1", "gromacs@2024.*")).toBe(true);
    expect(matchesPattern("gromacs@2024.5", "gromacs@2024.*")).toBe(true);
    expect(matchesPattern("gromacs@2023.1", "gromacs@2024.*")).toBe(false);
  });

  test("wildcard name", () => {
    expect(matchesPattern("gromacs@2024.1", "*@2024.1")).toBe(true);
    expect(matchesPattern("gromacs@2024.1", "*@*")).toBe(true);
  });

  test("strips compiler/variant suffix from spec when matching name@version", () => {
    expect(matchesPattern("gromacs@2024.1%gcc@13.2.0", "gromacs@2024.1")).toBe(true);
    expect(matchesPattern("gromacs@2024.1+mpi", "gromacs@2024.1")).toBe(true);
    expect(matchesPattern("gromacs@2024.1 ~mpi", "gromacs@2024.1")).toBe(true);
  });

  test("matches bare package patterns against full Spack specs", () => {
    expect(matchesPattern("gromacs@2024.1 +mpi cuda_arch=80 %gcc@13.2.0", "gromacs")).toBe(true);
    expect(matchesPattern("gromacs@2024.1 +mpi cuda_arch=80", "gromacs@*")).toBe(true);
    expect(matchesPattern("gromacs-gpu@2024.1", "gromacs")).toBe(false);
  });

  test("normalizes whitespace", () => {
    expect(matchesPattern("  gromacs@2024.1  ", "gromacs@2024.1")).toBe(true);
  });

  test("rejects empty inputs gracefully", () => {
    expect(matchesPattern("", "gromacs@2024.1")).toBe(false);
    expect(matchesPattern("gromacs@2024.1", "")).toBe(false);
  });

  test("dot in version is literal", () => {
    // 2024X1 shouldn't match 2024.1
    expect(matchesPattern("gromacs@2024X1", "gromacs@2024.1")).toBe(false);
  });
});

describe("decidePolicy", () => {
  const empty: SpackPolicy = { lockEnabled: false };

  test("allow when lock=false and no lists", () => {
    expect(decidePolicy("gromacs@2024.1", empty)).toBe("allow");
  });

  test("denyList: rejects matching spec", () => {
    const p: SpackPolicy = { lockEnabled: false, denyList: ["lammps@*"] };
    const r = decidePolicy("lammps@2024.1", p);
    expect(r).not.toBe("allow");
    if (typeof r === "object") expect(r.reject).toMatch(/deny/);
  });

  test("denyList: passes non-matching spec", () => {
    const p: SpackPolicy = { lockEnabled: false, denyList: ["lammps@*"] };
    expect(decidePolicy("gromacs@2024.1", p)).toBe("allow");
  });

  test("allowList without lock: passes matching spec", () => {
    const p: SpackPolicy = { lockEnabled: false, allowList: ["gromacs@*"] };
    expect(decidePolicy("gromacs@2024.1", p)).toBe("allow");
  });

  test("allowList accepts bare package names for full Spack specs", () => {
    const p: SpackPolicy = { lockEnabled: true, allowList: ["gromacs"] };
    expect(decidePolicy("gromacs@2024.1 +mpi cuda_arch=80", p)).toBe("allow");
  });

  test("allowList without lock: rejects non-matching spec", () => {
    const p: SpackPolicy = { lockEnabled: false, allowList: ["gromacs@*"] };
    const r = decidePolicy("lammps@2024.1", p);
    expect(r).not.toBe("allow");
    if (typeof r === "object") expect(r.reject).toMatch(/allow/);
  });

  test("lockEnabled=true rejects when allowList missing or empty", () => {
    const p: SpackPolicy = { lockEnabled: true };
    const r = decidePolicy("gromacs@2024.1", p);
    expect(r).not.toBe("allow");
    if (typeof r === "object") expect(r.reject).toMatch(/lock/i);
  });

  test("lockEnabled=true allows only allowList matches", () => {
    const p: SpackPolicy = { lockEnabled: true, allowList: ["gromacs@2024.*"] };
    expect(decidePolicy("gromacs@2024.1", p)).toBe("allow");
    const r = decidePolicy("lammps@2024.1", p);
    expect(r).not.toBe("allow");
  });

  test("denyList overrides allowList match (defense in depth)", () => {
    const p: SpackPolicy = {
      lockEnabled: true,
      allowList: ["gromacs@*"],
      denyList: ["gromacs@2024.0"],
    };
    expect(decidePolicy("gromacs@2024.1", p)).toBe("allow");
    const r = decidePolicy("gromacs@2024.0", p);
    expect(r).not.toBe("allow");
    if (typeof r === "object") expect(r.reject).toMatch(/deny/);
  });

  test("deny check runs before lock check (clearer reject reason)", () => {
    const p: SpackPolicy = { lockEnabled: true, denyList: ["lammps@*"] };
    const r = decidePolicy("lammps@2024.1", p);
    expect(r).not.toBe("allow");
    if (typeof r === "object") expect(r.reject).toMatch(/deny/);
  });

  test("rejects empty spec input with a clear reason", () => {
    const r = decidePolicy("", empty);
    expect(r).not.toBe("allow");
  });
});
