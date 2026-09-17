import { describe, expect, test } from "bun:test";
import { ShellExecRegistry } from "./shell-exec-registry";

describe("ShellExecRegistry", () => {
  test("discard removes an abandoned request without resolving it", () => {
    const registry = new ShellExecRegistry();
    const pending = registry.await("request-a", 10_000);

    expect(registry.discard("request-a")).toBe(true);
    expect(registry.discard("request-a")).toBe(false);
    expect(
      registry.resolve("request-a", {
        stdout: "ignored",
        stderr: "",
        exitCode: 0,
        error: "",
      }),
    ).toBe(false);

    void pending;
  });
});
