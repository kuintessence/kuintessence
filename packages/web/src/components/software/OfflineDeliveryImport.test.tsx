import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { requestSoftwareJson } from "../../lib/software-client";
import { OfflineDeliveryImport } from "./OfflineDeliveryImport";

vi.mock("../../lib/software-client", () => ({
  requestSoftwareJson: vi.fn(),
  softwareWriteHeaders: () => ({}),
}));
vi.mock("../../lib/spack-materials-client", () => ({ uploadSpackMaterial: vi.fn() }));
beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const plan = {
  version: 1,
  name: "fixture",
  release: "1",
  repository: "public/fixture",
  files: [],
  items: [
    {
      id: "binding",
      kind: "binding",
      change: {
        action: "disable",
        scope: "platform",
        spec: "hello@1.0",
        expectedRevision: 1,
        reason: "Explicit plan",
      },
    },
  ],
};

test("delivery requires preflight and preserves explicit actions in the request", async () => {
  vi.mocked(requestSoftwareJson).mockResolvedValue({
    digest: "sha256:test",
    status: "planned",
    items: [{ id: "binding", kind: "binding", status: "planned" }],
  });
  render(<OfflineDeliveryImport isCurrent={() => true} canWriteRepository={() => true} />);
  const file = new File([JSON.stringify(plan)], "delivery.json", { type: "application/json" });
  fireEvent.change(screen.getByLabelText("交付清单"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText("上传并预检").hasAttribute("disabled")).toBe(false));
  expect(screen.getByText("导入").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByText("上传并预检"));
  await waitFor(() => expect(screen.getByText("导入").hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByText("导入"));
  await waitFor(() =>
    expect(requestSoftwareJson).toHaveBeenCalledWith(
      "/offline-deliveries/import",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"action":"disable"'),
      }),
    ),
  );
});

test("revoked sessions cannot issue import requests", async () => {
  render(<OfflineDeliveryImport isCurrent={() => false} canWriteRepository={() => true} />);
  fireEvent.change(screen.getByLabelText("交付清单"), {
    target: { files: [new File([JSON.stringify(plan)], "delivery.json")] },
  });
  expect(screen.getByText("上传并预检").hasAttribute("disabled")).toBe(true);
  expect(requestSoftwareJson).not.toHaveBeenCalled();
});

test("a planned report with blocked items does not claim it is ready to import", async () => {
  vi.mocked(requestSoftwareJson).mockResolvedValue({
    digest: "sha256:test",
    status: "planned",
    items: [
      {
        id: "binding",
        kind: "binding",
        status: "conflict",
        code: "REVISION_MISMATCH",
        receipt: { expectedRevision: 1 },
      },
    ],
  });
  render(<OfflineDeliveryImport isCurrent={() => true} canWriteRepository={() => true} />);
  fireEvent.change(screen.getByLabelText("交付清单"), {
    target: { files: [new File([JSON.stringify(plan)], "delivery.json")] },
  });
  const preflight = screen.getByRole("button", { name: "上传并预检" });
  await waitFor(() => expect(preflight.hasAttribute("disabled")).toBe(false));
  fireEvent.click(preflight);
  await screen.findByText("REVISION_MISMATCH");
  expect(screen.getByRole("heading", { name: "预检结果" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "可导入" })).toBeNull();
  expect(screen.getByRole("button", { name: /^导入$/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("收据").closest("details")?.open).toBe(false);
  expect(screen.getByText("清单摘要").closest("details")?.open).toBe(false);
});

test.each([
  "newer",
  "cleared",
  "invalid",
])("ignores an older manifest read after the selection is %s", async (selection) => {
  vi.mocked(requestSoftwareJson).mockResolvedValue({
    digest: "sha256:test",
    status: "planned",
    items: [{ id: "binding", kind: "binding", status: "planned" }],
  });
  let finishRead!: (value: string) => void;
  const older = new File([], "older.json");
  vi.spyOn(older, "text").mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
  );
  render(<OfflineDeliveryImport isCurrent={() => true} canWriteRepository={() => true} />);
  const input = screen.getByLabelText("交付清单");
  fireEvent.change(input, { target: { files: [older] } });
  const newer = new File(
    [selection === "invalid" ? "invalid" : JSON.stringify({ ...plan, name: "newer" })],
    "newer.json",
  );
  await act(async () => {
    fireEvent.change(input, { target: { files: selection === "cleared" ? [] : [newer] } });
  });
  await act(async () => finishRead(JSON.stringify(plan)));
  const preflight = screen.getByRole("button", { name: "上传并预检" });
  if (selection === "newer") {
    fireEvent.click(preflight);
    await waitFor(() => expect(requestSoftwareJson).toHaveBeenCalled());
    const options = vi.mocked(requestSoftwareJson).mock.calls[0]?.[1];
    expect(JSON.parse(String(options?.body)).name).toBe("newer");
  } else {
    expect(preflight.hasAttribute("disabled")).toBe(true);
    expect(requestSoftwareJson).not.toHaveBeenCalled();
  }
});

test("a failed recheck invalidates the earlier successful preflight", async () => {
  vi.mocked(requestSoftwareJson)
    .mockResolvedValueOnce({
      digest: "sha256:test",
      status: "planned",
      items: [{ id: "binding", kind: "binding", status: "planned" }],
    })
    .mockRejectedValueOnce(new Error("network failure"));
  render(<OfflineDeliveryImport isCurrent={() => true} canWriteRepository={() => true} />);
  fireEvent.change(screen.getByLabelText("交付清单"), {
    target: { files: [new File([JSON.stringify(plan)], "delivery.json")] },
  });
  const preflight = screen.getByRole("button", { name: "上传并预检" });
  const execute = screen.getByRole("button", { name: /^导入$/ });
  await waitFor(() => expect(preflight.hasAttribute("disabled")).toBe(false));
  fireEvent.click(preflight);
  await waitFor(() => expect(execute.hasAttribute("disabled")).toBe(false));
  fireEvent.click(preflight);
  await screen.findByRole("alert");
  expect(execute.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("region", { name: "导入结果" })).toBeNull();
});
