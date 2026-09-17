import { describe, expect, test } from "bun:test";
import type { PreferenceSpec } from "@kuintessence/shared";
import { mergePreferences } from "./merge";

describe("mergePreferences", () => {
  test("returns empty when no layers", () => {
    expect(mergePreferences()).toEqual({});
  });

  test("hard limits: lower of base or override wins", () => {
    const base: PreferenceSpec = { hardLimits: { maxCpus: 32, maxMemoryMb: 128_000 } };
    const override: PreferenceSpec = { hardLimits: { maxCpus: 16 } };
    const out = mergePreferences(base, override);
    expect(out.hardLimits?.maxCpus).toBe(16);
    expect(out.hardLimits?.maxMemoryMb).toBe(128_000);
  });

  test("hard limits: override CANNOT raise above base", () => {
    const base: PreferenceSpec = { hardLimits: { maxCpus: 8 } };
    const override: PreferenceSpec = { hardLimits: { maxCpus: 64 } };
    const out = mergePreferences(base, override);
    expect(out.hardLimits?.maxCpus).toBe(8);
  });

  test("site policy allow: intersection of both lists", () => {
    const base: PreferenceSpec = { sitePolicy: { allowedAgents: ["a", "b", "c"] } };
    const override: PreferenceSpec = { sitePolicy: { allowedAgents: ["b", "c", "d"] } };
    const out = mergePreferences(base, override);
    expect(out.sitePolicy?.allowedAgents?.sort()).toEqual(["b", "c"]);
  });

  test("site policy deny: union of both lists", () => {
    const base: PreferenceSpec = { sitePolicy: { deniedAgents: ["bad-1"] } };
    const override: PreferenceSpec = { sitePolicy: { deniedAgents: ["bad-2"] } };
    const out = mergePreferences(base, override);
    expect(out.sitePolicy?.deniedAgents?.sort()).toEqual(["bad-1", "bad-2"]);
  });

  test("site policy: deny union deduplicates", () => {
    const base: PreferenceSpec = { sitePolicy: { deniedAgents: ["x", "y"] } };
    const override: PreferenceSpec = { sitePolicy: { deniedAgents: ["y", "z"] } };
    const out = mergePreferences(base, override);
    expect(out.sitePolicy?.deniedAgents?.sort()).toEqual(["x", "y", "z"]);
  });

  test("site policy: only base has allowedAgents -> override preserves it", () => {
    const base: PreferenceSpec = { sitePolicy: { allowedAgents: ["a", "b"] } };
    const override: PreferenceSpec = { sitePolicy: { deniedAgents: ["c"] } };
    const out = mergePreferences(base, override);
    expect(out.sitePolicy?.allowedAgents?.sort()).toEqual(["a", "b"]);
    expect(out.sitePolicy?.deniedAgents).toEqual(["c"]);
  });

  test("soft weights: most-specific layer wins entirely", () => {
    const base: PreferenceSpec = {
      softWeights: { loadWeight: 1, costWeight: 1, localityWeight: 1, queueWaitWeight: 1 },
    };
    const override: PreferenceSpec = {
      softWeights: { loadWeight: 5, costWeight: 0, localityWeight: 0.5, queueWaitWeight: 2 },
    };
    const out = mergePreferences(base, override);
    expect(out.softWeights).toEqual(override.softWeights);
  });

  test("3 layers tighten: global allows X, org adds deny, user reduces cpus", () => {
    const global: PreferenceSpec = {
      hardLimits: { maxCpus: 64, maxWallTimeSec: 86400 },
      sitePolicy: { allowedAgents: ["a", "b", "c"] },
    };
    const org: PreferenceSpec = {
      sitePolicy: { deniedAgents: ["b"] },
      hardLimits: { maxWallTimeSec: 7200 },
    };
    const user: PreferenceSpec = {
      hardLimits: { maxCpus: 8 },
    };
    const out = mergePreferences(global, org, user);
    expect(out.hardLimits?.maxCpus).toBe(8);
    expect(out.hardLimits?.maxWallTimeSec).toBe(7200);
    expect(out.sitePolicy?.allowedAgents?.sort()).toEqual(["a", "b", "c"]);
    expect(out.sitePolicy?.deniedAgents).toEqual(["b"]);
  });

  test("undefined layers are skipped", () => {
    const base: PreferenceSpec = { hardLimits: { maxCpus: 16 } };
    const out = mergePreferences(undefined, base, undefined);
    expect(out.hardLimits?.maxCpus).toBe(16);
  });

  test("costRates merge: per-cluster, most-specific wins, union of keys", () => {
    const merged = mergePreferences(
      { costRates: { "cluster-a": 0.1, "cluster-b": 0.2 } }, // global
      { costRates: { "cluster-b": 0.25 } }, // org overrides b
      { costRates: { "cluster-c": 0.05 } }, // user adds c
    );
    expect(merged.costRates).toEqual({
      "cluster-a": 0.1,
      "cluster-b": 0.25,
      "cluster-c": 0.05,
    });
  });

  test("costRates: undefined layers are skipped, base preserved", () => {
    const merged = mergePreferences({ costRates: { x: 1 } }, {}, undefined);
    expect(merged.costRates).toEqual({ x: 1 });
  });
});
