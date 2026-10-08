const { describe, expect, test } = require("bun:test");
const { validateCredentials, credentialData } = require("./credentials.cjs");
const path = require("node:path");

const user = "reviewer@example.test";
const password = "a-dedicated-fixed-preview-password";
const decode = (data, key) => Buffer.from(data[key], "base64").toString("utf8");
const hash = () => "fixture-hash";

describe("fixed preview Basic Auth credentials", () => {
  test("uses the configured account across PRs but keeps internal credentials isolated", () => {
    const first = credentialData({}, "kq-pr-17", user, password, hash);
    const second = credentialData({}, "kq-pr-18", user, password, hash);
    for (const data of [first, second]) {
      expect(decode(data, "PREVIEW_USER")).toBe(user);
      expect(decode(data, "PREVIEW_PASSWORD")).toBe(password);
      expect(decode(data, "PREVIEW_HTPASSWD")).toBe(`${user}:fixture-hash\n`);
    }
    for (const key of ["JWT_SECRET", "POSTGRES_PASSWORD", "RUSTFS_SECRET_KEY", "NETDRIVE_SECRET_KEY", "PREVIEW_COOKIE"]) {
      expect(first[key]).not.toBe(second[key]);
    }
    expect(decode(first, "DATABASE_URL")).toContain("kq-pr-17-postgres");
    expect(decode(second, "DATABASE_URL")).toContain("kq-pr-18-postgres");
  });

  test("reuses hashes and sessions on redeploy without hashing again", () => {
    const initial = credentialData({}, "kq-pr-17", user, password, hash);
    expect(credentialData(initial, "kq-pr-17", user, password, () => {
      throw new Error("Unchanged credentials must not be hashed again");
    })).toEqual(initial);
  });

  test.each(["user", "password", "legacy"])("rotating %s invalidates the old session without replacing backend credentials", (mode) => {
    const initial = credentialData({}, "kq-pr-17", user, password, hash);
    const previous = { ...initial };
    if (mode === "legacy") {
      delete previous.PREVIEW_USER;
      previous.PREVIEW_HTPASSWD = Buffer.from("preview:legacy-hash\n").toString("base64");
    }
    const nextUser = mode === "user" ? "another-reviewer" : user;
    const nextPassword = mode === "password" ? `${password}-rotated` : password;
    const next = credentialData(previous, "kq-pr-17", nextUser, nextPassword, hash);
    expect(decode(next, "PREVIEW_USER")).toBe(nextUser);
    expect(decode(next, "PREVIEW_PASSWORD")).toBe(nextPassword);
    expect(decode(next, "PREVIEW_HTPASSWD")).toBe(`${nextUser}:fixture-hash\n`);
    expect(next.PREVIEW_COOKIE).not.toBe(initial.PREVIEW_COOKIE);
    for (const key of ["JWT_SECRET", "POSTGRES_PASSWORD", "DATABASE_URL", "RUSTFS_SECRET_KEY", "NETDRIVE_SECRET_KEY"]) {
      expect(next[key]).toBe(initial[key]);
    }
    expect(initial.PREVIEW_USER).toBe(Buffer.from(user).toString("base64"));
  });

  test.each([undefined, "", "reviewer:injected", "reviewer\n", "reviewer\r", "reviewer\u2028", "reviewer\u0000", "reviewer name", "-reviewer", "a".repeat(65)])("rejects invalid or missing PREVIEW_USER %j", (invalid) => {
    expect(() => validateCredentials(invalid, password)).toThrow("PREVIEW_USER");
  });

  test.each([undefined, "", "short", `${password}\n`, `${password}\r`, `${password}\u0000`, `${password}\t`, `${password}\u007f`])("rejects invalid or missing PREVIEW_PASSWORD %j", (invalid) => {
    expect(() => validateCredentials(user, invalid)).toThrow("PREVIEW_PASSWORD");
  });

  test("accepts the documented username and password boundaries", () => {
    expect(() => validateCredentials("a".repeat(64), "p".repeat(24))).not.toThrow();
    expect(() => validateCredentials("Reviewer_01.name@example-test", `${password}:with spaces`)).not.toThrow();
  });

  test("never falls back to stored credentials when GitHub secrets are missing", () => {
    const initial = credentialData({}, "kq-pr-17", user, password, hash);
    expect(() => credentialData(initial, "kq-pr-17", undefined, password, hash)).toThrow("PREVIEW_USER");
    expect(() => credentialData(initial, "kq-pr-17", user, undefined, hash)).toThrow("PREVIEW_PASSWORD");
  });

  test.each([true, false])("CLI preflight validates without creating credentials or leaking values: %s", (valid) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(__dirname, "credentials.cjs"), "validate"],
      env: { PATH: process.env.PATH, PREVIEW_USER: user, PREVIEW_PASSWORD: valid ? password : "PRIVATE_BAD_PASSWORD" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(valid ? 0 : 1);
    const output = result.stdout.toString() + result.stderr.toString();
    for (const value of [user, password, "PRIVATE_BAD_PASSWORD"]) expect(output).not.toContain(value);
    if (valid) expect(output).toBe("");
    else expect(output).toContain("check PREVIEW_USER and PREVIEW_PASSWORD secrets");
  });
});
