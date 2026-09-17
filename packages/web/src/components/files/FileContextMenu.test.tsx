import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FileContextMenu } from "./FileContextMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const target = {
  x: 370,
  y: 805,
  label: "a-very-long-output-filename-that-must-not-resize-the-menu.txt",
  path: "results/output.txt",
  kind: "file" as const,
};

test("keeps the menu inside a narrow viewport and supports keyboard navigation", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
  const onClose = vi.fn();

  render(
    <FileContextMenu
      target={target}
      actions={["copy", "delete"]}
      onAction={vi.fn()}
      onClose={onClose}
    />,
  );

  const menu = screen.getByTestId("files-context-menu");
  expect(menu.className).toContain("w-44");
  expect(menu.style.left).toBe("191px");
  expect(menu.style.top).toBe("680px");
  expect(document.activeElement).toBe(screen.getByTestId("files-context-copy"));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByTestId("files-context-delete"));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByTestId("files-context-copy"));
  fireEvent.keyDown(window, { key: "End" });
  expect(document.activeElement).toBe(screen.getByTestId("files-context-delete"));
  fireEvent.keyDown(window, { key: "Home" });
  expect(document.activeElement).toBe(screen.getByTestId("files-context-copy"));
});

test("Escape closes the menu and restores focus to its trigger", () => {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  const onClose = vi.fn();
  render(
    <FileContextMenu
      target={target}
      actions={["copy"]}
      onAction={vi.fn()}
      onClose={onClose}
      restoreFocusTo={trigger}
    />,
  );

  fireEvent.keyDown(window, { key: "Escape" });

  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("opening a previously absent menu focuses its first enabled action", () => {
  const props = {
    actions: ["copy", "delete"] as const,
    disabledActions: { copy: true },
    onAction: vi.fn(),
    onClose: vi.fn(),
  };
  const { rerender } = render(<FileContextMenu {...props} target={null} />);
  rerender(<FileContextMenu {...props} target={target} />);
  expect(document.activeElement).toBe(screen.getByTestId("files-context-delete"));
});

test("closing menu retains its surface but cannot dispatch an action", () => {
  document.documentElement.style.setProperty("--kq-motion-fast", "100ms");
  const props = { actions: ["delete"] as const, onAction: vi.fn(), onClose: vi.fn() };
  const { rerender, unmount } = render(<FileContextMenu {...props} target={target} />);
  rerender(<FileContextMenu {...props} target={null} />);
  expect(screen.getByTestId("files-context-menu").getAttribute("data-state")).toBe("closed");
  const button = screen.getByTestId("files-context-delete") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(props.onAction).not.toHaveBeenCalled();
  unmount();
  document.documentElement.style.removeProperty("--kq-motion-fast");
});
