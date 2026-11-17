import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setAuth } from "../../lib/auth";
import { setLang } from "../../lib/i18n";
import { FunctionMapRegion } from "./FunctionMapRegion";
import { MapPreferencesPanel } from "./MapPreferencesPanel";
import { DEFAULT_MAP_PREFERENCES } from "./preferences";

const key = "kq.function-maps.v1:member%40example.test";
beforeEach(() => {
  localStorage.clear();
  setLang("zh");
  setAuth({ email: "member@example.test", role: "user", token: null });
});
afterEach(cleanup);
const diagram = <p data-testid="test-diagram">资源依赖</p>;
function dual() {
  return (
    <FunctionMapRegion
      page="D02"
      title="提供方"
      type="dependency"
      diagram={diagram}
      common={<p>待处理异常</p>}
      dashboard={<input aria-label="共有业务状态" defaultValue="初始值" />}
    />
  );
}
test("manual choices are remembered and both views keep their mounted state", () => {
  const view = render(dual());
  fireEvent.change(screen.getByLabelText("共有业务状态"), { target: { value: "正在查看" } });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "资源关系" }), { button: 0, ctrlKey: false });
  expect(screen.getByText("待处理异常")).toBeTruthy();
  expect((screen.getByLabelText("共有业务状态") as HTMLInputElement).value).toBe("正在查看");
  expect(JSON.parse(localStorage.getItem(key) ?? "{}").pages.D02.last).toBe("diagram");
  view.unmount();
  render(dual());
  expect(screen.getByRole("tab", { name: "资源关系" }).getAttribute("aria-selected")).toBe("true");
});
test.each([
  "fixed",
  "recommended",
] as const)("manual changes do not rewrite %s defaults", (mode) => {
  const stored = { ...DEFAULT_MAP_PREFERENCES, dual: { mode, fixed: "data" } };
  localStorage.setItem(key, JSON.stringify(stored));
  render(dual());
  fireEvent.mouseDown(screen.getByRole("tab", { name: "资源关系" }), { button: 0, ctrlKey: false });
  expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual(stored);
});
test("a collapsed diagram keeps an accessible recovery control and retains content", () => {
  render(<FunctionMapRegion page="D05" title="个人中心" type="dependency" diagram={diagram} />);
  fireEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(screen.getByRole("button", { name: "展开" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByTestId("test-diagram").parentElement?.hidden).toBe(true);
  expect(JSON.parse(localStorage.getItem(key) ?? "{}").pages.D05.last).toBe("collapsed");
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(screen.getByTestId("test-diagram").parentElement?.hidden).toBe(false);
});
test("saving a page rule leaves the current view unchanged until the next visit", () => {
  const view = render(dual());
  fireEvent.click(screen.getByRole("button", { name: "视图设置" }));
  fireEvent.click(screen.getByRole("radio", { name: "固定默认" }));
  fireEvent.change(screen.getByLabelText("默认显示"), { target: { value: "diagram" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("tab", { name: "数据概览" }).getAttribute("aria-selected")).toBe("true");
  view.unmount();
  render(dual());
  expect(screen.getByRole("tab", { name: "资源关系" }).getAttribute("aria-selected")).toBe("true");
});
test("unavailable diagram does not overwrite its remembered selection", () => {
  localStorage.setItem(
    key,
    JSON.stringify({ ...DEFAULT_MAP_PREFERENCES, pages: { D02: { last: "diagram" } } }),
  );
  const view = render(
    <FunctionMapRegion
      page="D02"
      title="提供方"
      type="dependency"
      diagram={diagram}
      dashboard={<p>加载失败</p>}
      diagramAvailable={false}
    />,
  );
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByText("加载失败")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(key) ?? "{}").pages.D02.last).toBe("diagram");
  view.unmount();
  render(dual());
  expect(screen.getByRole("tab", { name: "资源关系" }).getAttribute("aria-selected")).toBe("true");
});
test("central preferences are isolated by account", () => {
  const view = render(<MapPreferencesPanel />);
  fireEvent.change(screen.getByLabelText("连线效果"), { target: { value: "flow" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  view.unmount();
  setAuth({ email: "another@example.test", role: "user", token: null });
  render(<MapPreferencesPanel />);
  expect((screen.getByLabelText("连线效果") as HTMLSelectElement).value).toBe("static");
  expect(JSON.parse(localStorage.getItem(key) ?? "{}").appearance.flow).toBe(true);
});

test("an empty dashboard result retains dual-view capability and a valid default", () => {
  render(
    <FunctionMapRegion
      page="G10"
      title="用量计量"
      type="dependency"
      diagram={diagram}
      dashboard={null}
      common={<p>查询失败，请重试</p>}
    />,
  );
  expect(screen.getByRole("tab", { name: "数据概览" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "资源关系" })).toBeTruthy();
  expect(screen.getByText("查询失败，请重试")).toBeTruthy();
  expect(localStorage.getItem(key)).toBeNull();
});
