import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { requestSoftwareJson } from "../../lib/software-client";
import { OfflineDeliveryImport } from "./OfflineDeliveryImport";

vi.mock("../../lib/software-client", () => ({
  requestSoftwareJson: vi.fn(),
  softwareWriteHeaders: () => ({}),
}));
vi.mock("../../lib/spack-materials-client", () => ({ uploadSpackMaterial: vi.fn() }));
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
  fireEvent.change(screen.getByLabelText("交付清单 JSON"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText("上传并预检").hasAttribute("disabled")).toBe(false));
  expect(screen.getByText("执行 / 重试清单").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByText("上传并预检"));
  await waitFor(() =>
    expect(screen.getByText("执行 / 重试清单").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByText("执行 / 重试清单"));
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
  fireEvent.change(screen.getByLabelText("交付清单 JSON"), {
    target: { files: [new File([JSON.stringify(plan)], "delivery.json")] },
  });
  expect(screen.getByText("上传并预检").hasAttribute("disabled")).toBe(true);
  expect(requestSoftwareJson).not.toHaveBeenCalled();
});
