import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setLang } from "../../lib/i18n";
import catalog from "./catalog.json";
import { FunctionMapView } from "./FunctionMapView";
import { functionMapIcons } from "./icons";
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
  for (const selector of ["foreignObject button", ".function-map-mobile-node"]) {
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
