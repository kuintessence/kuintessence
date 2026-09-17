import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CapabilityLoadingOverlay } from "./CapabilityLoadingOverlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CapabilityLoadingOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("covers the first frame and fades out after the minimum visible interval", () => {
    const { rerender } = render(
      <CapabilityLoadingOverlay
        state={{ status: "loading", data: null, error: null }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId("capability-loading-overlay").classList.contains("opacity-100")).toBe(
      true,
    );

    rerender(
      <CapabilityLoadingOverlay
        state={{
          status: "ready",
          data: {
            principal: { userId: null, email: "user@example.com", role: "user" },
            capabilities: ["workspace.consumer.access"],
            contexts: [{ id: "personal", type: "personal" }],
            activeContextId: "personal",
            devicePolicy: {
              highRiskMutations: "desktop-only",
              mobileMode: "observe-approve",
            },
          },
          error: null,
        }}
        onRetry={vi.fn()}
      />,
    );
    act(() => vi.advanceTimersByTime(320));
    expect(screen.getByTestId("capability-loading-overlay").classList.contains("opacity-0")).toBe(
      true,
    );
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByTestId("capability-loading-overlay")).toBeNull();
  });
});
