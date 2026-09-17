import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getActiveConfigPath, loadCliConfig, saveCliConfig } from "./config";

const TMP = join(tmpdir(), "kq-cli-test-config");
const TMP_FILE = join(TMP, "config.json");

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
  // Ensure KQ_CONFIG_FILE is not left set between tests
  delete process.env.KQ_CONFIG_FILE;
});

describe("CLI config", () => {
  test("returns defaults when file does not exist", () => {
    const cfg = loadCliConfig(TMP_FILE);
    expect(cfg.serverUrl).toBe("http://localhost:3000");
    expect(cfg.token).toBeUndefined();
  });

  test("save then load round-trip", () => {
    saveCliConfig({ serverUrl: "http://server:3000", token: "abc" }, TMP_FILE);
    const cfg = loadCliConfig(TMP_FILE);
    expect(cfg.serverUrl).toBe("http://server:3000");
    expect(cfg.token).toBe("abc");
  });

  test("merges with defaults when partial", () => {
    saveCliConfig({ serverUrl: "http://server:3000" }, TMP_FILE);
    const cfg = loadCliConfig(TMP_FILE);
    expect(cfg.serverUrl).toBe("http://server:3000");
    expect(cfg.token).toBeUndefined();
  });

  // The config holds the auth token; on a multi-user HPC login node a
  // world-readable file leaks it. Must be owner-only (0600), dir 0700.
  test("writes the token file owner-only (0600) and the dir 0700", () => {
    const target = join(TMP, "nested", "config.json");
    saveCliConfig({ serverUrl: "http://server:3000", token: "secret-token" }, target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(target)).mode & 0o777).toBe(0o700);
  });

  test("tightens an already-existing world-readable token file to 0600", () => {
    const target = join(TMP, "config.json");
    mkdirSync(TMP, { recursive: true });
    writeFileSync(target, "{}", { mode: 0o644 });
    saveCliConfig({ serverUrl: "http://server:3000", token: "secret" }, target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("returns defaults on malformed JSON", () => {
    saveCliConfig({ serverUrl: "http://server:3000" }, TMP_FILE);
    // Corrupt the file
    writeFileSync(TMP_FILE, "not-valid-json");
    const cfg = loadCliConfig(TMP_FILE);
    expect(cfg.serverUrl).toBe("http://localhost:3000");
  });
});

describe("KQ_CONFIG_FILE env var", () => {
  test("with KQ_CONFIG_FILE unset, default path is ~/.kq/config.json", () => {
    const prev = process.env.KQ_CONFIG_FILE;
    try {
      delete process.env.KQ_CONFIG_FILE;
      const expected = join(homedir(), ".kq", "config.json");
      expect(getActiveConfigPath()).toBe(expected);
    } finally {
      if (prev !== undefined) process.env.KQ_CONFIG_FILE = prev;
      else delete process.env.KQ_CONFIG_FILE;
    }
  });

  test("with KQ_CONFIG_FILE set to an existing path, loadCliConfig reads from that path", () => {
    const envFile = join(TMP, "env-config.json");
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      envFile,
      JSON.stringify({ serverUrl: "http://env-server:9999", token: "env-token" }),
    );

    const prev = process.env.KQ_CONFIG_FILE;
    try {
      process.env.KQ_CONFIG_FILE = envFile;
      const cfg = loadCliConfig();
      expect(cfg.serverUrl).toBe("http://env-server:9999");
      expect(cfg.token).toBe("env-token");
      expect(getActiveConfigPath()).toBe(envFile);
    } finally {
      if (prev !== undefined) process.env.KQ_CONFIG_FILE = prev;
      else delete process.env.KQ_CONFIG_FILE;
    }
  });

  test("with KQ_CONFIG_FILE set to a non-existent path, returns DEFAULT_CONFIG", () => {
    const nonExistentFile = join(TMP, "does-not-exist", "config.json");

    const prev = process.env.KQ_CONFIG_FILE;
    try {
      process.env.KQ_CONFIG_FILE = nonExistentFile;
      const cfg = loadCliConfig();
      expect(cfg.serverUrl).toBe("http://localhost:3000");
      expect(cfg.token).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KQ_CONFIG_FILE = prev;
      else delete process.env.KQ_CONFIG_FILE;
    }
  });
});
