import { ApiError } from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import i18n from "./i18n";
import { toUserFacingError, toUserFacingExecutionFailure } from "./user-facing-error";

afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.removeItem("kq.lang");
  await i18n.changeLanguage("zh");
});

beforeEach(async () => {
  localStorage.setItem("kq.lang", "zh");
  await i18n.changeLanguage("zh");
  // Keep the presenter tests deterministic even when the browser language was
  // initialized by another test file.
  expect(i18n.language).toMatch(/^zh/);
});

describe("toUserFacingError", () => {
  test("maps permission failures without exposing API code or message", () => {
    const text = toUserFacingError(
      new ApiError(403, "FORBIDDEN", "Authorization denied", { reason: "RBAC" }),
    );
    expect(text).toContain("没有执行此操作的权限");
    expect(text).not.toContain("Authorization denied");
    expect(text).not.toContain("FORBIDDEN");
  });

  test("maps resource, conflict, validation, and rate-limit statuses", () => {
    expect(toUserFacingError(new ApiError(404, "NOT_FOUND", "private detail"))).toContain(
      "资源不存在",
    );
    expect(toUserFacingError(new ApiError(409, "CONFLICT", "private detail"))).toContain(
      "状态已发生变化",
    );
    expect(toUserFacingError(new ApiError(422, "VALIDATION_ERROR", "private detail"))).toContain(
      "检查输入",
    );
    expect(toUserFacingError(new ApiError(429, "RATE_LIMITED", "private detail"))).toContain(
      "过于频繁",
    );
  });

  test("uses an operation fallback for unknown server failures", () => {
    expect(
      toUserFacingError(
        new ApiError(503, "INTERNAL_ERROR", "database password leaked"),
        "无法加载软件目录",
      ),
    ).toBe("无法加载软件目录");
  });

  test("supports English copy", async () => {
    localStorage.setItem("kq.lang", "en");
    await i18n.changeLanguage("en");
    const text = toUserFacingError(new ApiError(403, "FORBIDDEN", "Authorization denied"));
    expect(text).toContain("does not have permission");
    expect(text).not.toContain("Authorization denied");
    expect(text).not.toContain("FORBIDDEN");
  });

  test("keeps a local validation message when it is not technical", () => {
    expect(toUserFacingError(new Error("YAML line 3 is invalid"))).toBe("YAML line 3 is invalid");
    expect(toUserFacingError(new Error("Authorization denied"), "无法保存脚本")).toBe(
      "无法保存脚本",
    );
    expect(toUserFacingError(new Error("database password leaked"))).toContain("操作未完成");
  });
});

describe("toUserFacingExecutionFailure", () => {
  test("preserves scientific runtime diagnostics", () => {
    expect(toUserFacingExecutionFailure("LAMMPS: Invalid atom style at input line 42")).toBe(
      "LAMMPS: Invalid atom style at input line 42",
    );
  });

  test("does not expose platform authorization or stack diagnostics", () => {
    const fallback = "系统未记录可展示的失败原因";
    expect(toUserFacingExecutionFailure("Authorization denied: tuple missing", fallback)).toBe(
      fallback,
    );
    expect(toUserFacingExecutionFailure("boom\n    at run (/app/index.ts:12:3)", fallback)).toBe(
      fallback,
    );
    expect(toUserFacingExecutionFailure("Not authorized to use dataset", fallback)).toBe(fallback);
    expect(toUserFacingExecutionFailure("runner token: private-value", fallback)).toBe(fallback);
    expect(
      toUserFacingExecutionFailure("SqliteError: database disk image is malformed", fallback),
    ).toBe(fallback);
    expect(toUserFacingExecutionFailure("AWS_ACCESS_KEY_ID=private-value", fallback)).toBe(
      fallback,
    );
    expect(toUserFacingExecutionFailure("credential: private-value", fallback)).toBe(fallback);
    expect(toUserFacingExecutionFailure("Bearer private-value", fallback)).toBe(fallback);
  });
});
