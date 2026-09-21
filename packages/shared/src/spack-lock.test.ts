import { describe, expect, test } from "bun:test";
import { inspectSpackLock, SPACK_LOCK_MAX_BYTES, type SpackLockReport } from "./spack-lock";

const binding = {
  spec: "zlib@1.3.1 +shared",
  spackVersion: "1.0.0",
  target: "linux-rocky9-x86_64",
};
const encoder = new TextEncoder();
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
function hash(index: number): string {
  let suffix = "";
  do {
    suffix = alphabet[index % 32] + suffix;
    index = Math.floor(index / 32);
  } while (index);
  return suffix.padStart(32, "a");
}
const rootHash = hash(0);
const dependencyHash = hash(1);

function node(index = 0, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: index === 0 ? "zlib" : `dep-${index}`,
    version: "1.3.1",
    namespace: "builtin",
    hash: hash(index),
    arch: { platform: "linux", platform_os: "rocky9", target: "x86_64" },
    parameters: { shared: true, cflags: [] },
    ...patch,
  };
}

function edge(index: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: index === 0 ? "zlib" : `dep-${index}`,
    hash: hash(index),
    parameters: { deptypes: ["build", "link"], virtuals: [], direct: true },
    ...patch,
  };
}

function lock(
  nodes: Record<string, unknown> = { [rootHash]: node() },
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
    spack: { version: "1.0.0" },
    roots: [{ hash: rootHash, spec: binding.spec }],
    concrete_specs: nodes,
    ...patch,
  };
}

function inspect(value: unknown, selectedBinding = binding): SpackLockReport {
  return inspectSpackLock(encoder.encode(JSON.stringify(value)), selectedBinding);
}

function expectError(report: SpackLockReport, code?: string): void {
  expect(report.validation).toBe("static-only");
  expect(report.valid).toBe(false);
  expect(report.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
  if (code) {
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code }));
  }
}

function chain(count: number): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      hash(index),
      node(index, { dependencies: index + 1 < count ? [edge(index + 1)] : [] }),
    ]),
  );
}

describe("inspectSpackLock format and binding", () => {
  test("accepts the verified format but reports static-only limitations, never readiness", () => {
    const report = inspect(lock());
    expect(report).toEqual({
      validation: "static-only",
      valid: true,
      rootHash,
      nodeCount: 1,
      externalCount: 0,
      architectures: ["linux-rocky9-x86_64"],
      diagnostics: [
        expect.objectContaining({ severity: "warning", code: "host-target-unverified" }),
        expect.objectContaining({ severity: "warning", code: "source-coverage-unverified" }),
        expect.objectContaining({ severity: "warning", code: "root-spec-unverified" }),
        expect.objectContaining({ severity: "warning", code: "dag-hash-unverified" }),
        expect.objectContaining({ severity: "warning", code: "recipe-compatibility-unverified" }),
      ],
    });
    expect(report).not.toHaveProperty("ready");
  });

  test.each([
    "",
    "{",
    '{"x": 1,}',
    "{unquoted: true}",
    "---\nroots: []",
    '{"x": NaN}',
    '{"x": Infinity}',
    '{"x": 1} {"x": 2}',
    '{"x": /* comment */ 1}',
    '{"x": "\\x61"}',
    '\uFEFF{"x": 1}',
  ])("rejects non-JSON syntax without throwing: %s", (text) => {
    expectError(inspectSpackLock(encoder.encode(text), binding), "invalid-json");
  });

  test.each(
    [null, [], true, 1, "lock"].map((value) => [value] as const),
  )("rejects a non-object document: %j", (value) => {
    expectError(inspect(value), "invalid-document");
  });

  test("rejects malformed UTF-8 rather than silently replacing invalid bytes", () => {
    const prefix = encoder.encode('{"extra":"');
    const suffix = encoder.encode('"}');
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
      expectError(
        inspectSpackLock(new Uint8Array([...prefix, ...invalid, ...suffix]), binding),
        "invalid-utf8",
      );
    }
  });

  test.each([
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"extra":[{"a":1,"a":2}]}',
    '{"extra":{"__proto__":1,"__proto__":2}}',
    '{"extra":{"a\\\\b":1,"a\\u005cb":2}}',
    '{"extra":{"a\\"b":1,"a\\u0022b":2}}',
    '{"extra":true,"nested":{"a":[]},"extra":false}',
    '{"nested":{"x":[]},"nested":[]}',
  ])("rejects duplicate decoded JSON keys in every object: %s", (text) => {
    expectError(inspectSpackLock(encoder.encode(text), binding), "duplicate-json-key");
  });

  test("does not mistake separate object keys or strings for duplicates or unsupported fields", () => {
    expect(
      inspect(
        lock(undefined, {
          extra: [{ x: 1 }, { x: 2 }],
          text: '"dev_path":1,{"x":1,"x":2} [ ] \\\\ \\"',
        }),
      ).valid,
    ).toBe(true);
  });

  test.each(
    [
      null,
      [],
      {},
      { "file-type": "spec", "lockfile-version": 6, "specfile-version": 5 },
      { "file-type": "spack-lockfile", "lockfile-version": 5, "specfile-version": 5 },
      { "file-type": "spack-lockfile", "lockfile-version": 7, "specfile-version": 5 },
      { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 4 },
      { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 6 },
      { "file-type": "spack-lockfile", "lockfile-version": "6", "specfile-version": 5 },
    ].map((value) => [value] as const),
  )("rejects missing or unverified metadata: %j", (_meta) => {
    expectError(inspect(lock(undefined, { _meta })), "unsupported-format");
  });

  test.each([
    "0.23.1",
    "1.0",
    "v1.0.0",
    "1.0.0-dev",
    "1.0.1",
    "1.1.0",
    "develop",
    "",
  ])("rejects unverified producer and binding versions: %s", (version) => {
    expectError(inspect(lock(undefined, { spack: { version } })), "unsupported-spack-version");
    expectError(
      inspect(lock(), { ...binding, spackVersion: version }),
      "unsupported-spack-version",
    );
  });

  test.each(
    [null, {}, [], { version: 1 }].map((value) => [value] as const),
  )("requires producer metadata: %j", (spack) => {
    expectError(inspect(lock(undefined, { spack })), "unsupported-spack-version");
  });

  test.each(
    [
      null,
      {},
      [],
      [null],
      [{ hash: rootHash }],
      [
        { hash: rootHash, spec: binding.spec },
        { hash: dependencyHash, spec: "other" },
      ],
    ].map((value) => [value] as const),
  )("requires exactly one well-formed root: %j", (roots) => {
    expectError(inspect(lock(undefined, { roots })));
  });

  test("matches the abstract root spec exactly without trimming or parsing spec grammar", () => {
    expectError(inspect(lock(), { ...binding, spec: `${binding.spec} ` }), "root-spec-mismatch");
    const opaque = "zlib opaque spec syntax that is not interpreted";
    expect(
      inspect(lock(undefined, { roots: [{ hash: rootHash, spec: opaque }] }), {
        ...binding,
        spec: opaque,
      }).valid,
    ).toBe(true);
    expectError(
      inspect(lock(undefined, { roots: [{ hash: rootHash, spec: "" }] }), {
        ...binding,
        spec: "",
      }),
    );
  });

  test("checks only an unambiguous leading root name and optional namespace", () => {
    for (const spec of [
      "other@1.3.1",
      "builtin.other +shared",
      "other.zlib@1.3.1",
      "  other@1.3.1",
    ]) {
      expectError(
        inspect(lock(undefined, { roots: [{ hash: rootHash, spec }] }), {
          ...binding,
          spec,
        }),
        "root-name-mismatch",
      );
    }
    for (const spec of ["builtin.zlib@1.3.1", "zlib@9.9 +not_a_real_variant", "@1.3.1"]) {
      const report = inspect(lock(undefined, { roots: [{ hash: rootHash, spec }] }), {
        ...binding,
        spec,
      });
      expect(report.valid).toBe(true);
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "warning",
          code: "root-spec-unverified",
        }),
      );
    }
  });

  test.each([
    "linux-x86_64",
    "x86_64",
    "linux-ubuntu24-x86_64",
    "linux-rocky9-zen4",
    "",
  ])("requires the exact root architecture triple, not a host compatibility guess: %s", (target) => {
    expectError(inspect(lock(), { ...binding, target }), "target-mismatch");
  });

  test.each([
    "a".repeat(31),
    "a".repeat(33),
    `${"a".repeat(32)}\n`,
    "A".repeat(32),
    "0".repeat(32),
    "__proto__",
  ])("rejects malformed root hashes: %s", (badHash) => {
    expectError(
      inspect(lock(undefined, { roots: [{ hash: badHash, spec: binding.spec }] })),
      "invalid-root-hash",
    );
  });

  test("rejects a valid-looking root hash missing from concrete_specs", () => {
    expectError(inspect(lock({ [dependencyHash]: node(1) })), "missing-root");
  });
});

describe("inspectSpackLock nodes and edges", () => {
  test.each(
    [null, [], {}, "nodes"].map((value) => [value] as const),
  )("requires a nonempty node map: %j", (concrete_specs) => {
    expectError(inspect(lock(undefined, { concrete_specs })));
  });

  test.each(
    [null, [], "node"].map((value) => [value] as const),
  )("rejects malformed nodes: %j", (value) => {
    expectError(inspect(lock({ [rootHash]: value })), "invalid-node");
  });

  test.each([
    "name",
    "version",
    "namespace",
    "arch",
    "parameters",
  ])("requires node field %s", (field) => {
    const value = node();
    delete value[field];
    expectError(inspect(lock({ [rootHash]: value })), "invalid-node");
  });

  test.each([
    { name: "" },
    { name: 1 },
    { name: " " },
    { version: "" },
    { version: 1 },
    { version: " " },
    { namespace: "" },
    { namespace: null },
    { parameters: [] },
    { parameters: null },
    { arch: "linux-rocky9-x86_64" },
    { arch: [] },
    { arch: { platform: "linux", target: "x86_64" } },
    { arch: { platform: "", platform_os: "rocky9", target: "x86_64" } },
    { arch: { platform: "linux", platform_os: "rocky9", target: {} } },
    { arch: { platform: "linux", platform_os: "rocky9", target: "" } },
    { arch: { platform: "linux", platform_os: "rocky9", target: { name: 1 } } },
  ])("rejects malformed required node fields: %j", (patch) => {
    expectError(inspect(lock({ [rootHash]: node(0, patch) })), "invalid-node");
  });

  test("accepts named architecture targets and reports distinct sorted triples", () => {
    const report = inspect(
      lock({
        [rootHash]: node(0, {
          arch: {
            platform: "linux",
            platform_os: "rocky9",
            target: { name: "x86_64", vendor: "generic" },
          },
          dependencies: [edge(1), edge(2)],
        }),
        [dependencyHash]: node(1, {
          arch: { platform: "darwin", platform_os: "sonoma", target: "aarch64" },
        }),
        [hash(2)]: node(2),
      }),
    );
    expect(report.valid).toBe(true);
    expect(report.nodeCount).toBe(3);
    expect(report.architectures).toEqual(["darwin-sonoma-aarch64", "linux-rocky9-x86_64"]);
  });

  test("bounds every architecture component and does not echo oversized values", () => {
    for (const field of ["platform", "platform_os", "target"]) {
      for (const component of [
        "x".repeat(129),
        "SECRET_ARCH_".repeat(128 * 1024),
        "linux/../../private",
        "rocky 9",
        "x86_64\n",
      ]) {
        const arch = {
          platform: "linux",
          platform_os: "rocky9",
          target: "x86_64",
          [field]: component,
        };
        const report = inspect(lock({ [rootHash]: node(0, { arch }) }));
        expectError(report, "invalid-node");
        expect(report.architectures).toEqual([]);
        expect(JSON.stringify(report).length).toBeLessThan(5_000);
        expect(JSON.stringify(report)).not.toContain("SECRET_ARCH_");
      }
    }
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, {
            arch: { platform: "linux", platform_os: "rocky9", target: { name: "x".repeat(129) } },
          }),
        }),
      ),
      "invalid-node",
    );
  });

  test("accepts architecture components at the 128-character limit", () => {
    const component = "a".repeat(128);
    const target = `${component}-${component}-${component}`;
    const report = inspect(
      lock({
        [rootHash]: node(0, {
          arch: { platform: component, platform_os: component, target: { name: component } },
        }),
      }),
      { ...binding, target },
    );
    expect(report.valid).toBe(true);
    expect(report.architectures).toEqual([target]);
  });

  test("requires node keys and embedded hashes to be valid and identical", () => {
    for (const [key, embedded] of [
      [rootHash, dependencyHash],
      [rootHash, undefined],
      [rootHash, "a".repeat(31)],
      ["a".repeat(31), "a".repeat(31)],
      [`${rootHash}\n`, `${rootHash}\n`],
    ]) {
      expectError(
        inspect(lock({ [String(key)]: node(0, { hash: embedded }) })),
        "invalid-node-hash",
      );
    }
  });

  test.each([
    false,
    null,
    "true",
    1,
  ])("rejects nonconcrete or malformed concrete flags: %j", (concrete) => {
    expectError(inspect(lock({ [rootHash]: node(0, { concrete }) })), "non-concrete-node");
  });

  test("accepts explicit concrete true and compiler dependencies, rejects legacy compiler properties", () => {
    expect(inspect(lock({ [rootHash]: node(0, { concrete: true }) })).valid).toBe(true);
    expectError(inspect(lock({ [rootHash]: node(0, { compiler: null }) })), "unsupported-compiler");
    expect(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies: [edge(1, { name: "gcc" })] }),
          [dependencyHash]: node(1, { name: "gcc", version: "13.2.0" }),
        }),
      ).valid,
    ).toBe(true);
  });

  test.each([
    "include_concrete",
    "develop",
    "dev_path",
  ])("rejects unsupported field %s at any depth", (field) => {
    expectError(inspect(lock(undefined, { [field]: {} })), "unsupported-feature");
    expectError(
      inspect(lock({ [rootHash]: node(0, { parameters: { [field]: "/not/read" } }) })),
      "unsupported-feature",
    );
  });

  test.each(
    [null, {}, "deps", [null], [{}], [edge(1, { hash: "short" })], [edge(1, { name: "" })]].map(
      (value) => [value] as const,
    ),
  )("rejects malformed dependency arrays and references: %j", (dependencies) => {
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies }),
          [dependencyHash]: node(1),
        }),
      ),
      "invalid-dependency",
    );
  });

  test.each(
    [
      undefined,
      null,
      [],
      {},
      { deptypes: [], virtuals: "mpi" },
      { deptypes: "build", virtuals: [] },
      { deptypes: ["unsupported"], virtuals: [] },
      { deptypes: ["build", "build"], virtuals: [] },
      { deptypes: ["link"], virtuals: [1] },
      { deptypes: ["link"], virtuals: [""] },
      { deptypes: ["link"], virtuals: ["mpi", "mpi"] },
      { deptypes: ["link"], virtuals: [], direct: "true" },
    ].map((value) => [value] as const),
  )("validates v5 dependency parameters: %j", (parameters) => {
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies: [edge(1, { parameters })] }),
          [dependencyHash]: node(1),
        }),
      ),
      "invalid-dependency",
    );
  });

  test("accepts virtual dependencies and optional direct, including empty deptypes", () => {
    for (const parameters of [
      { deptypes: ["build", "link", "run", "test"], virtuals: ["mpi"] },
      { deptypes: [], virtuals: [], direct: false },
    ]) {
      expect(
        inspect(
          lock({
            [rootHash]: node(0, { dependencies: [edge(1, { parameters })] }),
            [dependencyHash]: node(1),
          }),
        ).valid,
      ).toBe(true);
    }
  });

  test("checks missing dependency references and reference names", () => {
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies: [edge(1)] }),
        }),
      ),
      "missing-reference",
    );
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies: [edge(1, { name: "wrong" })] }),
          [dependencyHash]: node(1),
        }),
      ),
      "reference-name-mismatch",
    );
  });

  test("rejects repeated dependency edges even with different parameters", () => {
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, {
            dependencies: [edge(1), edge(1, { parameters: { deptypes: ["run"], virtuals: [] } })],
          }),
          [dependencyHash]: node(1),
        }),
      ),
      "duplicate-edge",
    );
  });

  test("checks build_spec shape, existence and names like dependency references", () => {
    for (const build_spec of [null, [], {}, { name: "dep-1", hash: "short" }]) {
      expectError(inspect(lock({ [rootHash]: node(0, { build_spec }) })), "invalid-build-spec");
    }
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { build_spec: { name: "dep-1", hash: dependencyHash } }),
        }),
      ),
      "missing-reference",
    );
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { build_spec: { name: "wrong", hash: dependencyHash } }),
          [dependencyHash]: node(1),
        }),
      ),
      "reference-name-mismatch",
    );
  });

  test("warns about external nodes without reporting paths, modules or extra data", () => {
    for (const external of [
      { path: "/untrusted/external", module: null, extra_attributes: { secret: "DO_NOT_COPY" } },
      { path: null, module: ["vendor/compiler"] },
      { path: null, modules: ["vendor/compiler"] },
    ]) {
      const report = inspect(lock({ [rootHash]: node(0, { external }) }));
      expect(report.valid).toBe(true);
      expect(report.externalCount).toBe(1);
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "warning",
          code: "external-dependency",
          hash: rootHash,
        }),
      );
      expect(JSON.stringify(report)).not.toMatch(/untrusted|vendor|DO_NOT_COPY/);
    }
  });

  test.each(
    [
      null,
      [],
      "/tmp",
      {},
      { path: 1 },
      { path: null, modules: [1] },
      { path: null, module: [] },
    ].map((value) => [value] as const),
  )("rejects malformed external metadata: %j", (external) => {
    expectError(inspect(lock({ [rootHash]: node(0, { external }) })), "invalid-external");
  });
});

describe("inspectSpackLock graph and resource bounds", () => {
  test("accepts shared DAG dependencies and build-only reachable nodes", () => {
    const nodes = {
      [rootHash]: node(0, { dependencies: [edge(1), edge(2)] }),
      [dependencyHash]: node(1, { dependencies: [edge(3)] }),
      [hash(2)]: node(2, { build_spec: { name: "dep-3", hash: hash(3) } }),
      [hash(3)]: node(3),
    };
    expect(inspect(lock(nodes)).valid).toBe(true);
  });

  test("rejects unreachable nodes and detects cycles in disconnected components too", () => {
    expectError(
      inspect(lock({ [rootHash]: node(), [dependencyHash]: node(1) })),
      "unreachable-node",
    );
    const report = inspect(
      lock({
        [rootHash]: node(),
        [dependencyHash]: node(1, { dependencies: [edge(1)] }),
      }),
    );
    expectError(report, "unreachable-node");
    expectError(report, "cycle");
  });

  test("rejects dependency, build_spec and mixed cycles", () => {
    expectError(inspect(lock({ [rootHash]: node(0, { dependencies: [edge(0)] }) })), "cycle");
    expectError(
      inspect(lock({ [rootHash]: node(0, { build_spec: { name: "zlib", hash: rootHash } }) })),
      "cycle",
    );
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, { dependencies: [edge(1)] }),
          [dependencyHash]: node(1, { build_spec: { name: "zlib", hash: rootHash } }),
        }),
      ),
      "cycle",
    );
  });

  test("accepts exactly 16 MiB and rejects one byte more before decoding", () => {
    expect(SPACK_LOCK_MAX_BYTES).toBe(16 * 1024 ** 2);
    const bytes = new Uint8Array(16 * 1024 ** 2).fill(0x20);
    bytes.set(encoder.encode(JSON.stringify(lock())));
    expect(inspectSpackLock(bytes, binding).valid).toBe(true);
    expectError(
      inspectSpackLock(new Uint8Array(bytes.length + 1).fill(0xff), binding),
      "byte-limit",
    );
  });

  test("handles a 10000-node deep graph and deep cycles without recursion", () => {
    const nodes = chain(10_000);
    expect(inspect(lock(nodes))).toMatchObject({ valid: true, nodeCount: 10_000 });
    nodes[hash(9_999)] = node(9_999, { build_spec: { name: "zlib", hash: rootHash } });
    expectError(inspect(lock(nodes)), "cycle");
  });

  test("rejects more than 10000 nodes", () => {
    expectError(inspect(lock(chain(10_001))), "node-limit");
  });

  test("keeps at most 64 distinct architecture triples and fails closed on overflow", () => {
    for (const count of [64, 65]) {
      const nodes = chain(count);
      for (let index = 1; index < count; index++) {
        const value = nodes[hash(index)];
        if (value) value.arch = { platform: "linux", platform_os: `os${index}`, target: "x86_64" };
      }
      const report = inspect(lock(nodes));
      expect(report.architectures).toHaveLength(64);
      if (count === 64) expect(report.valid).toBe(true);
      else expectError(report, "architecture-limit");
    }
  });

  test("applies the independent JSON budget even to an otherwise valid 100000-edge DAG", () => {
    const nodes: Record<string, unknown> = {};
    let remaining = 100_000;
    for (let index = 0; index < 450; index++) {
      const dependencies = [];
      for (let target = index + 1; target < 450 && remaining > 0; target++) {
        dependencies.push(edge(target));
        remaining--;
      }
      nodes[hash(index)] = node(index, { dependencies });
    }
    expect(remaining).toBe(0);
    expectError(inspect(lock(nodes)), "json-container-limit");
  });

  test("counts malformed edges and build_spec toward the 100000-edge limit", () => {
    const dependencies = Array.from({ length: 100_000 }, () => null);
    const atLimit = inspect(lock({ [rootHash]: node(0, { dependencies }) }));
    expectError(atLimit, "invalid-dependency");
    expect(atLimit.diagnostics.some((entry) => entry.code === "edge-limit")).toBe(false);
    expectError(
      inspect(
        lock({
          [rootHash]: node(0, {
            dependencies,
            build_spec: { name: "zlib", hash: rootHash },
          }),
        }),
      ),
      "edge-limit",
    );
  });

  test("caps diagnostics at 100 and fails closed even if the overflow contains only warnings", () => {
    for (const patch of [{ version: "" }, { external: { path: "/unverified", module: null } }]) {
      const nodes = chain(120);
      for (const value of Object.values(nodes)) Object.assign(value, patch);
      const report = inspect(lock(nodes));
      expect(report.diagnostics).toHaveLength(100);
      expectError(report, "diagnostic-limit");
    }
  });

  test("allows exactly 100 warnings and rejects the next warning", () => {
    for (const count of [95, 96]) {
      const nodes = chain(count);
      for (const value of Object.values(nodes)) value.external = { path: "/unverified" };
      const report = inspect(lock(nodes));
      expect(report.diagnostics).toHaveLength(100);
      if (count === 95) expect(report.valid).toBe(true);
      else expectError(report, "diagnostic-limit");
    }
  });

  test("handles large JSON strings within the byte limit without overflowing the scanner stack", () => {
    expect(inspect(lock(undefined, { extra: "x".repeat(8 * 1024 ** 2) })).valid).toBe(true);
    expect(inspect(lock(undefined, { extra: '\\"'.repeat(1024 ** 2) })).valid).toBe(true);
  });

  test("respects Uint8Array slice boundaries and does not mutate the input", () => {
    const serialized = encoder.encode(JSON.stringify(lock()));
    const buffer = new Uint8Array(serialized.length + 2).fill(0xff);
    buffer.set(serialized, 1);
    const bytes = buffer.subarray(1, -1);
    expect(inspectSpackLock(bytes, binding).valid).toBe(true);
    expect(bytes).toEqual(serialized);
    expect(buffer[0]).toBe(0xff);
    expect(buffer.at(-1)).toBe(0xff);
  });

  test("does not echo arbitrary keys, names or invalid hashes into diagnostics", () => {
    const secret = "PRIVATE_VALUE_".repeat(64 * 1024);
    const report = inspect(
      lock({
        [rootHash]: node(0, {
          name: secret,
          dependencies: [edge(1, { name: secret }), edge(2, { hash: secret })],
        }),
        [dependencyHash]: node(1),
        [secret]: node(2, { hash: secret, version: "" }),
      }),
    );
    expectError(report);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("PRIVATE_VALUE");
    expect(serialized.length).toBeLessThan(5_000);
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.hash !== undefined) {
        expect(diagnostic.hash).toHaveLength(32);
        expect(diagnostic.hash).toMatch(/^[a-z2-7]+$/);
      }
    }
  });

  test("accepts the integration fixture with empty parameters and omitted optional node fields", () => {
    expect(inspect(lock({ [rootHash]: node(0, { parameters: {} }) })).valid).toBe(true);
  });

  test("rejects excessive nesting before constructing a JSON tree or duplicate-key scopes", () => {
    const serialized = JSON.stringify(lock({ [rootHash]: node(0, { extra: "PLACEHOLDER" }) }));
    const deep = serialized.replace('"PLACEHOLDER"', `${"[".repeat(20_000)}0${"]".repeat(20_000)}`);
    expectError(inspectSpackLock(encoder.encode(deep), binding), "json-depth-limit");
    const attack = `${'{"x":'.repeat(1_000_000)}0${"}".repeat(1_000_000)}`;
    expectError(inspectSpackLock(encoder.encode(attack), binding), "json-depth-limit");
    // Invalid trailing syntax proves the depth guard precedes JSON.parse.
    expectError(inspectSpackLock(encoder.encode(`${attack}invalid`), binding), "json-depth-limit");
  });

  test("accepts 128 JSON levels but rejects 129, ignoring brackets and escaped quotes in strings", () => {
    const serialized = JSON.stringify(lock(undefined, { extra: "PLACEHOLDER" }));
    const atLimit = serialized.replace('"PLACEHOLDER"', `${"[".repeat(127)}0${"]".repeat(127)}`);
    expect(inspectSpackLock(encoder.encode(atLimit), binding).valid).toBe(true);
    const overLimit = serialized.replace('"PLACEHOLDER"', `${"[".repeat(128)}0${"]".repeat(128)}`);
    expectError(inspectSpackLock(encoder.encode(overLimit), binding), "json-depth-limit");
    expect(inspect(lock(undefined, { extra: '{["\\'.repeat(1_000) })).valid).toBe(true);
  });

  test("accepts 100000 JSON containers and rejects one more before parsing", () => {
    const serialized = JSON.stringify(
      lock({ [rootHash]: node(0, { parameters: {} }) }, { extra: "PLACEHOLDER" }),
    );
    // Nine fixture containers plus the extra array leave room for 99990 empty objects.
    const atLimit = serialized.replace('"PLACEHOLDER"', `[${"{},".repeat(99_989)}{}]`);
    expect(inspectSpackLock(encoder.encode(atLimit), binding).valid).toBe(true);
    const overLimit = serialized.replace('"PLACEHOLDER"', `[${"{},".repeat(99_990)}{}]`);
    expectError(inspectSpackLock(encoder.encode(overLimit), binding), "json-container-limit");
    const wideAttack = `[${"[],".repeat(1_000_000)}[]]invalid`;
    expectError(inspectSpackLock(encoder.encode(wideAttack), binding), "json-container-limit");
  });

  test("rejects more than 500000 JSON keys before parsing or allocating duplicate-key sets", () => {
    const keys = Array.from({ length: 500_001 }, (_, index) => `"k${index}":0`).join(",");
    expectError(inspectSpackLock(encoder.encode(`{${keys}}invalid`), binding), "json-key-limit");
  });

  test("rejects more than 2000000 JSON tokens even in a shallow primitive array", () => {
    const tokens = `[${"0,".repeat(1_999_999)}0]invalid`;
    expectError(inspectSpackLock(encoder.encode(tokens), binding), "json-token-limit");
  });

  test("ignores unknown node data without execution or report leakage", () => {
    const report = inspect(
      lock({
        [rootHash]: node(0, {
          extra: { command: "DO_NOT_EXECUTE", nested: [{ x: 1 }, { x: 2 }] },
          annotations: { compiler: "old compiler annotation" },
        }),
      }),
    );
    expect(report.valid).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/DO_NOT_EXECUTE|annotations|old compiler/);
  });
});
