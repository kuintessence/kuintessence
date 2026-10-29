import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("a blocked preflight keeps import disabled and leaves diagnostics available", async () => {
  vi.mocked(requestSoftwareJson).mockResolvedValue({
    digest: "sha256:test",
    status: "failed",
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
  expect(screen.getByRole("button", { name: /^导入$/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("收据").closest("details")?.open).toBe(false);
  expect(screen.getByText("清单摘要").closest("details")?.open).toBe(false);
});
