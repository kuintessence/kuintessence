import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { GlobalErrorPage } from "./GlobalErrorPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "globalError.title": "页面暂时无法加载",
        "globalError.description": "请重试，或返回工作台继续使用其他功能。",
        "globalError.retry": "重试",
        "globalError.home": "返回工作台",
      })[key] ?? key,
  }),
}));

describe("GlobalErrorPage", () => {
  test("hides internal error details and lets the user retry", () => {
    const reset = vi.fn();
    render(
      <GlobalErrorPage
        error={new Error("Authorization denied: FORBIDDEN database-internal-detail")}
        reset={reset}
      />,
    );

    expect(screen.getByText("页面暂时无法加载")).toBeTruthy();
    expect(
      screen.queryByText(/Authorization denied|FORBIDDEN|database-internal-detail/),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "返回工作台" }).getAttribute("href")).toBe("/");
  });
});
