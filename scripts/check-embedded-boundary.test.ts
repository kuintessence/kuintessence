import { expect, test } from "bun:test";
import { EMBEDDED_ROOTS, findForbiddenImports } from "./check-embedded-boundary";

const FORBIDDEN = ["stream", "server-client", "queue/", "auth/", "@kuintessence/server", "server/"];

test("scanned roots cover the kernel's re-exported surface (spack/adapters/monitor)", () => {
  expect(EMBEDDED_ROOTS).toContain("packages/agent/src/embedded/**/*.ts");
  expect(EMBEDDED_ROOTS).toContain("packages/agent/src/spack/**/*.ts");
  expect(EMBEDDED_ROOTS).toContain("packages/agent/src/adapters/**/*.ts");
  expect(EMBEDDED_ROOTS).toContain("packages/agent/src/monitor/**/*.ts");
});

test("flags a forbidden import placed under a spack-style path", () => {
  expect(
    findForbiddenImports(
      "packages/agent/src/spack/leak.ts",
      'import { AgentStream } from "../stream";\n',
      FORBIDDEN,
    ),
  ).toEqual(["../stream"]);
});

test("flags an embedded file importing a Server-coupled module", () => {
  const violations = findForbiddenImports(
    "embedded/x.ts",
    'import { AgentStream } from "../stream";\n',
    FORBIDDEN,
  );
  expect(violations).toEqual(["../stream"]);
});

test("flags a type-only import of a Server-coupled module too", () => {
  const violations = findForbiddenImports(
    "embedded/x.ts",
    'import type { Foo } from "../server-client";\n',
    FORBIDDEN,
  );
  expect(violations).toEqual(["../server-client"]);
});

test("allows adapters/monitor/shared/db imports", () => {
  const ok = findForbiddenImports(
    "embedded/x.ts",
    'import { detectScheduler } from "../adapters";\nimport { createSqliteDb } from "@kuintessence/db";\n',
    FORBIDDEN,
  );
  expect(ok).toEqual([]);
});

test("flags export-from and dynamic import of Server-coupled modules", () => {
  const violations = findForbiddenImports(
    "embedded/x.ts",
    'export { run } from "../queue/outbound-queue";\nconst m = await import("../auth/bootstrap");\n',
    FORBIDDEN,
  );
  expect(violations).toEqual(["../queue/outbound-queue", "../auth/bootstrap"]);
});

test("does not false-positive on segment substrings", () => {
  const ok = findForbiddenImports(
    "embedded/x.ts",
    'import { x } from "../streamlined";\nimport { y } from "../monitor";\nimport { z } from "node:stream/promises";\n',
    FORBIDDEN,
  );
  expect(ok).toEqual([]);
});

test("ignores a line comment mentioning a forbidden module", () => {
  expect(
    findForbiddenImports(
      "embedded/x.ts",
      '// must not import { X } from "../stream";\nimport { ok } from "../adapters";\n',
      FORBIDDEN,
    ),
  ).toEqual([]);
});

test("ignores a block comment mentioning a forbidden module", () => {
  expect(
    findForbiddenImports("embedded/x.ts", '/* import { X } from "../auth/foo"; */\n', FORBIDDEN),
  ).toEqual([]);
});

test("still flags a real import even when a comment also mentions one", () => {
  expect(
    findForbiddenImports(
      "embedded/x.ts",
      '// see ../queue/foo\nimport { X } from "../stream";\n',
      FORBIDDEN,
    ),
  ).toEqual(["../stream"]);
});

test("flags an import of the server package", () => {
  expect(
    findForbiddenImports("embedded/x.ts", 'import { x } from "@kuintessence/server";\n', FORBIDDEN),
  ).toEqual(["@kuintessence/server"]);
});

test("flags a relative import reaching into server", () => {
  expect(
    findForbiddenImports("embedded/x.ts", 'import { x } from "../../server/src/foo";\n', FORBIDDEN),
  ).toEqual(["../../server/src/foo"]);
});

test("still allows the shared package", () => {
  expect(
    findForbiddenImports("embedded/x.ts", 'import { x } from "@kuintessence/shared";\n', FORBIDDEN),
  ).toEqual([]);
});
