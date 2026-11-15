import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { nativeControl } from "../../../lib/test-resource-field";
import type { GraphEdge, GraphNode } from "../../../lib/yaml-graph-sync";
import { WorkflowSlotMappingDialog } from "../WorkflowSlotMappingDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function node(id: string, fileBatch = false): GraphNode {
  return {
    id,
    type: "SoftwareUsecaseComputing",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: id,
      kind: "SoftwareUsecaseComputing",
      raw: {
        type: "SoftwareUsecaseComputing",
        id,
        name: id,
        usecaseVersionId: "11111111-1111-4111-8111-111111111111",
        softwareVersionId: "22222222-2222-4222-8222-222222222222",
        outputSlots: [
          {
            type: "File",
            descriptor: "file",
            optional: false,
            origin: "UsecaseOut",
            isBatch: fileBatch,
          },
          { type: "Text", descriptor: "text", optional: false },
        ],
        inputSlots: [{ type: "File", descriptor: "file", optional: false, isBatch: false }],
      },
    },
  };
}
const edge: GraphEdge = {
  id: "e",
  source: "a",
  target: "b",
  slotRelations: [{ fromSlot: "file", toSlot: "file", transferStrategy: { type: "Network" } }],
};

test("upstream slot type changes invalidate existing mappings before confirm", () => {
  const confirm = vi.fn();
  const props = {
    edge,
    source: node("a"),
    target: node("b"),
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: confirm,
  };
  const view = render(<WorkflowSlotMappingDialog {...props} />);
  expect(screen.getByTestId("workflow-slot-mapping-confirm")).toHaveProperty("disabled", false);
  view.rerender(<WorkflowSlotMappingDialog {...props} source={node("a", true)} />);
  expect(screen.getByRole("alert").textContent).toContain("invalidMappings");
  expect(screen.getByTestId("workflow-slot-mapping-confirm")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByTestId("workflow-slot-mapping-confirm"));
  expect(confirm).not.toHaveBeenCalled();
});

test("changing source clears an incompatible destination and prevents adding a stale mapping", () => {
  render(
    <WorkflowSlotMappingDialog
      edge={null}
      source={node("a")}
      target={node("b")}
      open
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  // Radix tabs activate on mouse down, matching real pointer navigation.
  fireEvent.mouseDown(
    screen.getByRole("tab", { name: "workflow.editor.slotMapping.standardMode" }),
    { button: 0, ctrlKey: false },
  );
  const source = screen.getByRole("combobox", { name: "workflow.editor.slotMapping.output" });
  fireEvent.change(nativeControl(source), { target: { value: "text" } });
  expect(
    screen
      .getByRole("combobox", { name: "workflow.editor.slotMapping.input" })
      .getAttribute("value"),
  ).toBe("");
  expect(screen.getByTestId("workflow-slot-mapping-add")).toHaveProperty("disabled", true);
});
