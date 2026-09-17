import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "@kuintessence/db";
import { makeLocalStore } from "./select";

let savedKuintessenceHome: string | undefined;

beforeEach(() => {
  savedKuintessenceHome = process.env.KUINTESSENCE_HOME;
  delete process.env.KUINTESSENCE_HOME;
});

afterEach(() => {
  if (savedKuintessenceHome === undefined) {
    delete process.env.KUINTESSENCE_HOME;
  } else {
    process.env.KUINTESSENCE_HOME = savedKuintessenceHome;
  }
});

test("migrates legacy ~/.kq/local.db to ~/.kuintessence once (copy, keep legacy)", () => {
  const home = mkdtempSync(join(tmpdir(), "kq-home-"));
  mkdirSync(join(home, ".kq"), { recursive: true });
  const seed = createSqliteDb(join(home, ".kq", "local.db"));
  seed.$client.close();
  const store = makeLocalStore({ home });
  expect(store).toBeDefined();
  expect(existsSync(join(home, ".kuintessence", "local.db"))).toBe(true);
  expect(existsSync(join(home, ".kq", "local.db"))).toBe(true);
});

test("no migration when target already exists", () => {
  const home = mkdtempSync(join(tmpdir(), "kq-home-"));
  mkdirSync(join(home, ".kuintessence"), { recursive: true });
  const target = createSqliteDb(join(home, ".kuintessence", "local.db"));
  target.$client.close();
  mkdirSync(join(home, ".kq"), { recursive: true });
  const legacy = createSqliteDb(join(home, ".kq", "local.db"));
  legacy.$client.close();
  makeLocalStore({ home });
  expect(existsSync(join(home, ".kuintessence", "local.db"))).toBe(true);
});

test("KUINTESSENCE_HOME relocates the default store directory", () => {
  const home = mkdtempSync(join(tmpdir(), "kq-home-"));
  const relocated = mkdtempSync(join(tmpdir(), "kq-khome-"));
  process.env.KUINTESSENCE_HOME = relocated;
  const store = makeLocalStore({ home });
  expect(store).toBeDefined();
  expect(existsSync(join(relocated, "local.db"))).toBe(true);
  expect(existsSync(join(home, ".kuintessence", "local.db"))).toBe(false);
});
