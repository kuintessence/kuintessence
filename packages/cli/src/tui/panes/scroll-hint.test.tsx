import { describe, expect, test } from "bun:test";
import { render } from "../test-render";
import { ErrorBanner, ScrollHint } from "./scroll-hint";

describe("ScrollHint", () => {
  test("renders a directional count when rows are hidden", async () => {
    expect((await render(<ScrollHint count={7} direction="up" />)).lastFrame() ?? "").toContain(
      "↑ 7 more",
    );
    expect((await render(<ScrollHint count={3} direction="down" />)).lastFrame() ?? "").toContain(
      "↓ 3 more",
    );
  });

  test("renders nothing when no rows are hidden (count <= 0)", async () => {
    expect((await render(<ScrollHint count={0} direction="up" />)).lastFrame() ?? "").toBe("");
    expect((await render(<ScrollHint count={-2} direction="down" />)).lastFrame() ?? "").toBe("");
  });
});

describe("ErrorBanner", () => {
  test("shows the error with a warning glyph", async () => {
    expect((await render(<ErrorBanner error="server unreachable" />)).lastFrame() ?? "").toContain(
      "⚠ server unreachable",
    );
  });

  test("renders nothing without an error", async () => {
    expect((await render(<ErrorBanner error={undefined} />)).lastFrame() ?? "").toBe("");
  });
});
