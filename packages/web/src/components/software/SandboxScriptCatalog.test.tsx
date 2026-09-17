import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SandboxScriptCatalog } from "./SandboxScriptCatalog";

const sandboxClient = vi.hoisted(() => ({ listSandboxScripts: vi.fn() }));
const publishingAccess = vi.hoisted(() => ({ useSoftwarePublishingAccess: vi.fn() }));
const userFacingError = vi.hoisted(() => ({
  toUserFacingError: vi.fn(() => "当前账号没有执行此操作的权限"),
}));

vi.mock("../../lib/sandbox-client", () => sandboxClient);
vi.mock("../../lib/software-publishing-access", () => publishingAccess);
vi.mock("../../lib/user-facing-error", () => userFacingError);

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
    ...props
  }: {
    children?: ReactNode;
    params?: Record<string, string>;
    to: string;
    [key: string]: unknown;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const scripts = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "sandbox-script",
    name: "Normalize JSON",
    version: "1.0.0",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: null,
    ownerOrgId: null,
    providerOrgId: null,
    trustedForGlobalUse: true,
    sharedAccountEligible: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    payload: {
      kind: "sandbox-script",
      language: "python",
      runtimeProfileId: "00000000-0000-4000-8000-000000000010",
      entrypoint: "main.py",
      content: "print('ok')",
      sha256: "a".repeat(64),
      inputs: { rows: { type: "JSON", required: true } },
      outputs: {},
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    kind: "sandbox-script",
    name: "Archive Files",
    version: "0.2.0",
    source: "sp-draft",
    lifecycle: "draft",
    visibility: "private",
    ownerUserId: "00000000-0000-4000-8000-000000000020",
    ownerOrgId: null,
    providerOrgId: null,
    trustedForGlobalUse: false,
    sharedAccountEligible: false,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    payload: {
      kind: "sandbox-script",
      language: "bash",
      runtimeProfileId: "00000000-0000-4000-8000-000000000011",
      entrypoint: "main.sh",
      content: "true",
      sha256: "b".repeat(64),
      inputs: {},
      outputs: {},
    },
  },
];

beforeEach(() => {
  publishingAccess.useSoftwarePublishingAccess.mockReturnValue({ canPublish: true, ready: true });
});

afterEach(() => vi.clearAllMocks());

describe("SandboxScriptCatalog", () => {
  test("presents API authorization failures without exposing the server error", async () => {
    sandboxClient.listSandboxScripts.mockRejectedValue(new Error("Authorization denied"));

    render(<SandboxScriptCatalog />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("sandbox-script-catalog").textContent).toContain(
        "当前账号没有执行此操作的权限",
      );
    });
    expect(screen.getByTestId("sandbox-script-catalog").textContent).not.toContain(
      "Authorization denied",
    );
    expect(userFacingError.toUserFacingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Authorization denied" }),
      "software.unreachable",
    );
  });

  test("shows the shared catalog placeholder when the script library is empty", async () => {
    sandboxClient.listSandboxScripts.mockResolvedValue([]);
    render(<SandboxScriptCatalog />, { wrapper });

    const empty = await screen.findByTestId("sandbox-script-empty");
    expect(screen.getByTestId("sandbox-script-empty-placeholders").children).toHaveLength(3);
    expect(
      within(empty).getByRole("link", { name: "sandbox.catalog.create" }).getAttribute("href"),
    ).toBe("/software/scripts/new");
    expect(empty.textContent).toContain("sandbox.catalog.emptyLibraryTitle");
  });

  test("hides create actions without software.publish", async () => {
    publishingAccess.useSoftwarePublishingAccess.mockReturnValue({
      canPublish: false,
      ready: true,
    });
    sandboxClient.listSandboxScripts.mockResolvedValue([]);

    render(<SandboxScriptCatalog />, { wrapper });

    const empty = await screen.findByTestId("sandbox-script-empty");
    expect(within(empty).queryByRole("link", { name: "sandbox.catalog.create" })).toBeNull();
  });

  test("filters visible assets by language and descriptor search", async () => {
    sandboxClient.listSandboxScripts.mockResolvedValue(scripts);
    render(<SandboxScriptCatalog />, { wrapper });

    expect(await screen.findByText("Normalize JSON")).toBeTruthy();
    expect(screen.getByText("Archive Files")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("sandbox.catalog.language"), {
      target: { value: "python" },
    });
    expect(screen.queryByText("Archive Files")).toBeNull();

    fireEvent.change(screen.getByLabelText("sandbox.catalog.search"), {
      target: { value: "rows" },
    });
    expect(screen.getByText("Normalize JSON")).toBeTruthy();
  });

  test("shows governed identity eligibility from latest-revision attestations", async () => {
    sandboxClient.listSandboxScripts.mockResolvedValue(scripts);
    render(<SandboxScriptCatalog />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("sandbox.catalog.sharedEligible")).toBeTruthy();
      expect(screen.getByText("sandbox.catalog.mappedOnly")).toBeTruthy();
    });
  });

  test("opens a script from the card surface without hijacking the explicit action", async () => {
    sandboxClient.listSandboxScripts.mockResolvedValue(scripts);
    render(<SandboxScriptCatalog />, { wrapper });

    const card = await screen.findByTestId(`sandbox-script-card-${scripts[0]?.id}`);
    expect(
      screen.getByTestId(`sandbox-script-card-surface-${scripts[0]?.id}`).getAttribute("href"),
    ).toBe(`/software/scripts/${scripts[0]?.id}`);
    expect(
      within(card).getByRole("link", { name: "sandbox.catalog.open" }).getAttribute("href"),
    ).toBe(`/software/scripts/${scripts[0]?.id}`);
  });
});
