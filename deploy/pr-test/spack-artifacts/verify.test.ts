import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { loopbackOrigin, verifyMaterialImport } from "./verify";

describe("artifact verification loopback origins", () => {
  test.each([1, 3000, 3100, 15173, 65535])("accepts explicit loopback port %i", (port) => {
    const origin = `http://127.0.0.1:${port}`;
    expect(loopbackOrigin(origin)).toBe(origin);
    expect(loopbackOrigin(`${origin}/`)).toBe(origin);
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["relative", "/api"],
    ["scheme-relative", "//127.0.0.1:3000"],
    ["https", "https://127.0.0.1:3000"],
    ["file", "file:///fixture"],
    ["wildcard", "http://0.0.0.0:3000"],
    ["external", "http://example.invalid:3000"],
    ["private address", "http://10.0.0.1:3000"],
    ["loopback-looking hostname", "http://127.0.0.1.example.invalid:3000"],
    ["other loopback address", "http://127.0.0.2:3000"],
    ["localhost alias", "http://localhost:3000"],
    ["IPv6", "http://[::1]:3000"],
    ["username", "http://fixture@127.0.0.1:3000"],
    ["password", "http://:fixture@127.0.0.1:3000"],
    ["userinfo", "http://fixture:fixture@127.0.0.1:3000"],
    ["encoded username", "http://%66ixture@127.0.0.1:3000"],
    ["userinfo disguise", "http://127.0.0.1:3000@example.invalid:3000"],
    ["no port", "http://127.0.0.1"],
    ["default port", "http://127.0.0.1:80"],
    ["zero port", "http://127.0.0.1:0"],
    ["out-of-range port", "http://127.0.0.1:65536"],
    ["non-numeric port", "http://127.0.0.1:fixture"],
    ["API path", "http://127.0.0.1:3000/api"],
    ["query", "http://127.0.0.1:3000/?fixture=true"],
    ["fragment", "http://127.0.0.1:3000/#fixture"],
    ["embedded NUL", "http://127.0.\0.1:3000"],
    ["trailing NUL", "http://127.0.0.1:3000/\0"],
    ["trailing newline", "http://127.0.0.1:3000/\n"],
    ["trailing CRLF", "http://127.0.0.1:3000/\r\n"],
    ["trailing space", "http://127.0.0.1:3000/ "],
    ["trailing tab", "http://127.0.0.1:3000/\t"],
    ["origin trailing NUL", "http://127.0.0.1:3000\0"],
    ["origin trailing newline", "http://127.0.0.1:3000\n"],
    ["origin trailing space", "http://127.0.0.1:3000 "],
    ["leading whitespace", " \t\nhttp://127.0.0.1:3000"],
    ["embedded newline", "http://127.0.\n0.1:3000"],
    ["embedded tab", "http://127.0.0.1:30\t00"],
    ["normalized scheme", "HTTP://127.0.0.1:3000"],
    ["normalized address", "http://127.1:3000"],
    ["normalized port", "http://127.0.0.1:03000"],
    ["normalized path", "http://127.0.0.1:3000/./"],
  ] as const)("rejects %s", (_label, value) => {
    expect(() => loopbackOrigin(value)).toThrow();
  });
});

describe("artifact verifier preflight (no services)", () => {
  const defaults = {
    GITHUB_ACTIONS: "true",
    KQ_WEB_SERVER_PROXY_TARGET: "http://127.0.0.1:13000",
    KQ_WEB_REGISTRY_PROXY_TARGET: "http://127.0.0.1:13100",
    KQ_ARTIFACT_DIRECTORY: "/fixture/materials",
    KQ_ARTIFACT_RESULT_PATH: "/fixture/web-binding.json",
    KQ_ARTIFACT_REFERENCE_PATH: "/fixture/bootstrap-binding.json",
  };
  const saved = new Map<string, string | undefined>();
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    for (const [key, value] of Object.entries(defaults)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  test.each(["false", "TRUE", "1", ""])("rejects Actions flag %j before I/O", async (value) => {
    process.env.GITHUB_ACTIONS = value;
    await expect(verifyMaterialImport("empty")).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("requires the Actions flag to be present", async () => {
    delete process.env.GITHUB_ACTIONS;
    await expect(verifyMaterialImport("bootstrap")).rejects.toMatchObject({
      code: "ERR_ASSERTION",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(["KQ_WEB_SERVER_PROXY_TARGET", "KQ_WEB_REGISTRY_PROXY_TARGET"])(
    "rejects unsafe %s before reading the pack",
    async (key) => {
      process.env[key] = "http://fixture@127.0.0.1:13000";
      await expect(verifyMaterialImport("web")).rejects.toMatchObject({ code: "ERR_ASSERTION" });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  for (const key of [
    "KQ_ARTIFACT_DIRECTORY",
    "KQ_ARTIFACT_RESULT_PATH",
    "KQ_ARTIFACT_REFERENCE_PATH",
  ]) {
    test.each(["relative", "/fixture/../other", "/fixture//other", ""])(
      `rejects noncanonical ${key}: %j`,
      async (value) => {
        process.env[key] = value;
        await expect(verifyMaterialImport("web-restart")).rejects.toMatchObject({
          code: "ERR_ASSERTION",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  }
});
