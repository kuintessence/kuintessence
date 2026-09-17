import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir";

test("tui default is ~/.kuintessence", () => {
  expect(resolveDataDir({ form: "tui", home: "/home/u" })).toBe(join("/home/u", ".kuintessence"));
});
test("gui default is <exe-dir>/kuintessence", () => {
  expect(resolveDataDir({ form: "gui", execPath: "/opt/app/kq", home: "/home/u" })).toBe(
    join("/opt/app", "kuintessence"),
  );
});
test("gui falls back to ~/.kuintessence when execPath missing", () => {
  expect(resolveDataDir({ form: "gui", home: "/home/u" })).toBe(join("/home/u", ".kuintessence"));
});
test("explicit --data-dir wins over env and default", () => {
  expect(
    resolveDataDir({ form: "tui", home: "/home/u", explicit: "/scratch/x", env: "/env/y" }),
  ).toBe("/scratch/x");
});
test("KUINTESSENCE_HOME wins over default", () => {
  expect(resolveDataDir({ form: "tui", home: "/home/u", env: "/env/y" })).toBe("/env/y");
});
test("expands a leading ~ in explicit", () => {
  expect(resolveDataDir({ form: "tui", home: "/home/u", explicit: "~/d" })).toBe(
    join("/home/u", "d"),
  );
});
test("expands a leading ~ in env", () => {
  expect(resolveDataDir({ form: "tui", home: "/home/u", env: "~/e" })).toBe(join("/home/u", "e"));
});
test("bare ~ expands to home", () => {
  expect(resolveDataDir({ form: "tui", home: "/home/u", explicit: "~" })).toBe("/home/u");
});
