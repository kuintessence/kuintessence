import { expect, test } from "bun:test";
import {
  FederationEnvironmentLockSchema,
  FederationInputManifestSchema,
  federationCanonicalJson,
} from "./index";

const reference = {
  originSiteId: crypto.randomUUID(),
  kind: "dataset",
  id: crypto.randomUUID(),
  revision: "1",
  digest: `sha256:${"a".repeat(64)}`,
};
const inputs = {
  protocolVersion: 1,
  kind: "inputs",
  parameters: { threshold: 0.5 },
  datasets: [{ descriptor: "reads", asset: reference, selectedEntries: ["input/reads.fastq"] }],
  bindings: [],
};

test("portable content addressing ignores JSON object ordering but preserves array order and Unicode", () => {
  expect(federationCanonicalJson({ z: [1, 2], a: { 名称: "数据", alpha: false } })).toBe(
    federationCanonicalJson({ a: { alpha: false, 名称: "数据" }, z: [1, 2] }),
  );
  expect(federationCanonicalJson([1, 2])).not.toBe(federationCanonicalJson([2, 1]));
});

test("portable materials reject non-JSON values, excessive nesting and size", () => {
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), { a: undefined }, new Array(3)])
    expect(() => federationCanonicalJson(value)).toThrow();
  let nested: unknown = 1;
  for (let i = 0; i < 34; i++) nested = { value: nested };
  expect(() => federationCanonicalJson(nested)).toThrow("nesting");
  expect(() => federationCanonicalJson("x".repeat(1048576))).toThrow("MiB");
});

test("input manifests accept pinned datasets and reject paths, duplicate descriptors and arbitrary URLs", () => {
  expect(FederationInputManifestSchema.safeParse(inputs).success).toBe(true);
  for (const path of ["/etc/passwd", "../secret", "input/../secret", "a\\b", "a//b", "a\0b"])
    expect(
      FederationInputManifestSchema.safeParse({
        ...inputs,
        datasets: [{ ...inputs.datasets[0], selectedEntries: [path] }],
      }).success,
    ).toBe(false);
  expect(
    FederationInputManifestSchema.safeParse({
      ...inputs,
      datasets: [...inputs.datasets, ...inputs.datasets],
    }).success,
  ).toBe(false);
  expect(
    FederationInputManifestSchema.safeParse({
      ...inputs,
      downloadUrl: "https://private.invalid/data",
    }).success,
  ).toBe(false);
  const binding = { sourceRevisionId: crypto.randomUUID(), asset: reference };
  expect(
    FederationInputManifestSchema.safeParse({ ...inputs, bindings: [binding, binding] }).success,
  ).toBe(false);
});

test("environment locks require a target, native lock digest and pinned software hash", () => {
  const lock = {
    protocolVersion: 1,
    kind: "environment-lock",
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: reference.digest,
    software: [
      {
        asset: { ...reference, kind: "software" },
        concreteSpec: "gzip@1.13/abcdefg",
        dagHash: "abcdefg",
      },
    ],
  };
  expect(FederationEnvironmentLockSchema.safeParse(lock).success).toBe(true);
  expect(
    FederationEnvironmentLockSchema.safeParse({ ...lock, nativeLockDigest: null }).success,
  ).toBe(false);
  expect(
    FederationEnvironmentLockSchema.safeParse({
      ...lock,
      software: [{ ...lock.software[0], dagHash: "latest" }],
    }).success,
  ).toBe(false);
});

test("named bindings pin one revision and reject ambiguous aliases without changing old manifests", () => {
  const sourceSelector = { source: "official-upstream", name: "gzip", version: "1.13" };
  const binding = { sourceSelector, asset: { ...reference, kind: "software" } };
  expect(FederationInputManifestSchema.safeParse({ ...inputs, bindings: [binding] }).success).toBe(
    true,
  );
  expect(
    FederationInputManifestSchema.safeParse({
      ...inputs,
      bindings: [binding, { ...binding, asset: { ...binding.asset, id: crypto.randomUUID() } }],
    }).success,
  ).toBe(false);
  expect(
    FederationInputManifestSchema.safeParse({ ...inputs, bindings: [{ asset: reference }] })
      .success,
  ).toBe(false);
  const runtimeBinding = {
    sourceProfileId: crypto.randomUUID(),
    contract: { name: "python", version: "1" },
  };
  const lock = {
    protocolVersion: 1,
    kind: "environment-lock",
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: reference.digest,
    software: [],
    runtimeBindings: [runtimeBinding, runtimeBinding],
  };
  expect(FederationEnvironmentLockSchema.safeParse(lock).success).toBe(false);
  const software = {
    asset: { ...reference, kind: "software" },
    concreteSpec: "gzip@1.13",
    dagHash: "abcdefg",
  };
  expect(
    FederationEnvironmentLockSchema.safeParse({
      ...lock,
      runtimeBindings: [],
      software: [software, software],
    }).success,
  ).toBe(false);
});
