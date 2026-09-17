import { describe, expect, test } from "bun:test";
import { act } from "react";
import { SpikeApp } from "./spike";
import { render } from "./test-render";

describe("OpenTUI + Bun spike", () => {
  test("OpenTUI + React render to a frame under Bun", async () => {
    const { lastFrame } = await render(<SpikeApp />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("OpenTUI × Bun spike");
    expect(frame).toContain("count: 0");
    expect(frame).toContain("╭");
  });

  test("keyboard input, resize, and renderer teardown work together", async () => {
    const { lastFrame, mockInput, flush, resize, unmount } = await render(<SpikeApp />);
    await flush();
    act(() => mockInput.pressKey("k"));
    await flush();
    expect(lastFrame() ?? "").toContain("count: 1");

    act(() => resize(60, 12));
    await flush();
    expect((lastFrame() ?? "").split("\n")[0]?.length).toBe(60);
    expect(lastFrame() ?? "").toContain("count: 1");
    expect(() => unmount()).not.toThrow();
  });
});
