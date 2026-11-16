import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import catalog from "./catalog.json";
import { FunctionMapView } from "./FunctionMapView";
import { functionMapIcons } from "./icons";
import { MapPreferencesPanel } from "./MapPreferencesPanel";
import type { FunctionMap, MapRuntime } from "./model";
import { infrastructureRuntime } from "./runtime";

test("every catalog node and runtime placeholder has a registered inline SVG icon", () => {
  for (const model of catalog) {
    for (const node of model.nodes) {
      expect(node.icon, `${model.id}:${node.id}`).toBeTruthy();
      expect(node.icon in functionMapIcons, `${model.id}:${node.id}`).toBe(true);
    }
  }
  const runtime = infrastructureRuntime({
    state: "no-data",
    overviewState: "no-data",
    fetchedAt: 0,
    overviewFetchedAt: 0,
  });
  expect(runtime.nodes?.[0]?.icon).toBe("search");
  const model = catalog.find((map) => map.id === "T02") as FunctionMap;
  const { container } = render(<FunctionMapView model={model} language="zh" onOpen={() => {}} />);
  for (const selector of ["foreignObject button"]) {
    const buttons = container.querySelectorAll(selector);
    expect(buttons.length).toBe(model.nodes.length);
    buttons.forEach((button, index) => {
      const icon = button.querySelector("svg[data-function-map-icon]");
      expect(icon?.getAttribute("data-function-map-icon")).toBe(model.nodes[index]?.icon);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.querySelector("path, circle, rect, line, polyline, polygon")).toBeTruthy();
    });
  }
});

test("runtime summaries expose health independently of fetching and keep long evidence in details", () => {
  setLang("zh");
  const model = catalog.find((map) => map.id === "T01") as FunctionMap;
  const runtime: MapRuntime = {
    notice: { zh: "", en: "" },
    observations: model.nodes.map((node, index) => ({
      nodeId: node.id,
      acquisition: "ready",
      health: index === 1 ? "confirmed-fault" : "unknown",
      facts: { zh: "需要展开核查的完整长依据", en: "Full evidence available in details" },
      source: "existing health snapshot",
      observedAt: null,
      fetchedAt: null,
    })),
  };
  const { container } = render(
    <FunctionMapView model={model} runtime={runtime} language="zh" onOpen={() => {}} />,
  );
  const summaries = container.querySelectorAll("foreignObject [data-runtime-summary]");
  expect(summaries[1]?.textContent).toContain("已获取");
  expect(summaries[1]?.textContent).toContain("已确认异常");
  expect(summaries[0]?.textContent).toContain("健康未知");
  expect(screen.queryByText("需要展开核查的完整长依据")).toBeNull();
  fireEvent.click(container.querySelector("foreignObject button") as HTMLButtonElement);
  expect(screen.getByText("需要展开核查的完整长依据")).toBeTruthy();
});

test("node details use a dialog and opening an entrance closes it", () => {
  setLang("zh");
  const model = catalog.find((map) => map.id === "G10") as FunctionMap;
  const onOpen = vi.fn();
  const { container } = render(<FunctionMapView model={model} language="zh" onOpen={onOpen} />);
  const node = container.querySelector("foreignObject button") as HTMLButtonElement;
  fireEvent.click(node);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开已有入口" }));
  expect(onOpen).toHaveBeenCalledWith(model.nodes[0]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("appearance controls change flow and line styling without changing business relationships", () => {
  setLang("zh");
  const model = catalog.find((map) => map.id === "G10") as FunctionMap;
  const { container } = render(<FunctionMapView model={model} language="zh" onOpen={() => {}} />);
  expect(container.querySelectorAll(".function-map-connection")).toHaveLength(model.edges.length);
  expect(container.querySelector(".function-map-flow")).toBeNull();
  expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
  render(<MapPreferencesPanel />);
  expect((screen.getByRole("slider", { name: /流动周期/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("连线效果"), { target: { value: "flow" } });
  fireEvent.change(screen.getByLabelText("连线颜色"), { target: { value: "brand" } });
  fireEvent.change(screen.getByRole("slider", { name: /线宽/ }), { target: { value: "3" } });
  fireEvent.change(screen.getByRole("slider", { name: /流动周期/ }), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  const canvas = container.querySelector(".function-map-canvas") as HTMLElement;
  expect(canvas.style.getPropertyValue("--map-line-color")).toBe("var(--brand)");
  expect(canvas.style.getPropertyValue("--map-line-width")).toBe("3");
  expect(canvas.style.getPropertyValue("--map-flow-duration")).toBe("4s");
  expect(container.querySelectorAll(".function-map-flow")).toHaveLength(model.edges.length);
  fireEvent.change(screen.getByLabelText("连线效果"), { target: { value: "static" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(container.querySelector(".function-map-flow")).toBeNull();
});

test("long processes wrap into readable rows while retaining every relationship", () => {
  const model = catalog.find((map) => map.id === "G01") as FunctionMap;
  const { container } = render(<FunctionMapView model={model} language="zh" onOpen={() => {}} />);
  const nodes = container.querySelectorAll("foreignObject:has(button)");
  expect(nodes).toHaveLength(model.nodes.length);
  expect(nodes[0]?.getAttribute("y")).not.toBe(nodes[nodes.length - 1]?.getAttribute("y"));
  expect(container.querySelectorAll(".function-map-connection")).toHaveLength(model.edges.length);
  expect(
    Number(container.querySelector(".function-map-canvas > svg")?.getAttribute("width")),
  ).toBeLessThan(1000);
});
