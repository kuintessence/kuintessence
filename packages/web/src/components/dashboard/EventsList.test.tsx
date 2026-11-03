import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setLang } from "../../lib/i18n";
import { EventsList } from "./EventsList";

const entries = Array.from({ length: 15 }, (_, i) => ({
  id: `event-${i}`,
  actor: "admin@example.test",
  action:
    i === 0
      ? "interconnect.center.create"
      : i === 1
        ? "compute-provider.update"
        : "unrecognized.action",
  target: `target-${i}`,
  diff: { after: i === 0 ? { metadata: { name: "北京中心" } } : { name: "科研提供者" } },
  createdAt: "2026-11-03T00:00:00Z",
}));
test("resource audits retain action/object meaning and configurable feed length", () => {
  setLang("zh");
  const { rerender } = render(<EventsList entries={entries} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  expect(screen.getByText("新增算力中心")).toBeTruthy();
  expect(screen.getByText("北京中心")).toBeTruthy();
  expect(screen.getByText("修改算力提供者")).toBeTruthy();
  expect(screen.getByText("科研提供者")).toBeTruthy();
  expect(screen.queryByText("更新了平台配置")).toBeNull();
  expect(screen.getAllByText("unrecognized.action").length).toBeGreaterThan(0);
  rerender(<EventsList entries={entries} limit={100} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(15);
});

test("legacy delete.update events remain recognizable without inventing object names", () => {
  setLang("zh");
  render(
    <EventsList
      entries={[
        {
          id: "legacy",
          actor: "admin",
          action: "interconnect.center.delete.update",
          target: "legacy-center",
          createdAt: "2026-11-03T00:00:00Z",
          diff: { after: { id: "legacy-center" } },
        },
      ]}
    />,
  );
  expect(screen.getByText("删除算力中心")).toBeTruthy();
  expect(screen.getByText("legacy-center")).toBeTruthy();
});
