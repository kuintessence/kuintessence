import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toastSuccess, toastError, translate } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  translate: (key: string, values?: { version?: number }) =>
    values?.version ? `${key}:${values.version}` : key,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { FileTransferAuditConfigPanel } from "./FileTransferAuditConfigPanel";

const initialConfig = {
  userPlatformRetentionDays: 365,
  platformClusterRetentionDays: 180,
  downloadEvidenceMode: "controlled_gateway",
  policyVersion: 1,
  updatedAt: null,
  updatedBy: null,
};

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("FileTransferAuditConfigPanel", () => {
  test("loads and persists an operator-controlled policy with a reason", async () => {
    let putBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method === "PUT") {
          putBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              ...initialConfig,
              userPlatformRetentionDays: 730,
              platformClusterRetentionDays: 365,
              downloadEvidenceMode: "direct_authorization_only",
              policyVersion: 2,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(initialConfig), { status: 200 });
      }),
    );

    render(<FileTransferAuditConfigPanel canManage />);
    await screen.findByDisplayValue("365");
    fireEvent.change(screen.getByTestId("user-platform-retention-days"), {
      target: { value: "730" },
    });
    fireEvent.change(screen.getByTestId("platform-cluster-retention-days"), {
      target: { value: "365" },
    });
    fireEvent.change(screen.getByTestId("download-evidence-mode"), {
      target: { value: "direct_authorization_only" },
    });
    fireEvent.change(screen.getByTestId("file-transfer-audit-change-reason"), {
      target: { value: "演练期间延长保留期" },
    });
    fireEvent.click(screen.getByTestId("file-transfer-audit-save"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(putBody).toEqual({
      userPlatformRetentionDays: 730,
      platformClusterRetentionDays: 365,
      downloadEvidenceMode: "direct_authorization_only",
      changeReason: "演练期间延长保留期",
    });
    expect(screen.getByTestId("direct-authorization-warning")).toBeTruthy();
    expect(screen.getByText("settings.operations.fileTransferAudit.policyVersion:2")).toBeTruthy();
  });

  test("keeps audit viewers read-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(initialConfig), { status: 200 })),
    );

    render(<FileTransferAuditConfigPanel canManage={false} />);
    await screen.findByDisplayValue("365");

    expect((screen.getByTestId("user-platform-retention-days") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByTestId("file-transfer-audit-save")).toBeNull();
    expect(screen.queryByTestId("file-transfer-audit-change-reason")).toBeNull();
  });

  test("rejects invalid retention and a missing reason before the request", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(initialConfig), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FileTransferAuditConfigPanel canManage />);
    await screen.findByDisplayValue("365");
    fireEvent.change(screen.getByTestId("user-platform-retention-days"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByTestId("file-transfer-audit-save"));
    expect(toastError).toHaveBeenCalledWith(
      "settings.operations.fileTransferAudit.invalidRetention",
    );

    fireEvent.change(screen.getByTestId("user-platform-retention-days"), {
      target: { value: "365" },
    });
    fireEvent.click(screen.getByTestId("file-transfer-audit-save"));
    expect(toastError).toHaveBeenCalledWith("settings.operations.fileTransferAudit.invalidReason");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
