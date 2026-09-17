import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SandboxScriptStudio } from "./SandboxScriptStudio";

const navigate = vi.hoisted(() => vi.fn());
const sandboxClient = vi.hoisted(() => ({
  createSandboxScript: vi.fn(),
  createSandboxScriptRevision: vi.fn(),
  deleteSandboxScript: vi.fn(),
  getSandboxScript: vi.fn(),
  listSandboxRuntimeProfiles: vi.fn(),
  renderSandboxPrompt: vi.fn(),
  runSandboxScriptTest: vi.fn(),
}));
const publishingAccess = vi.hoisted(() => ({ canPublish: true, ready: true }));

vi.mock("../../lib/sandbox-client", () => sandboxClient);
vi.mock("../../lib/software-publishing-access", () => ({
  useSoftwarePublishingAccess: () => publishingAccess,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
    t: (key: string) => key,
  }),
}));

vi.mock("./SandboxCodeEditor", () => ({
  SandboxCodeEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}));

const scriptId = "00000000-0000-4000-8000-000000000001";
const runtimeProfileId = "00000000-0000-4000-8000-000000000010";
const revision = {
  id: "00000000-0000-4000-8000-000000000020",
  assetId: scriptId,
  revision: 4,
  payload: {
    kind: "sandbox-script" as const,
    language: "python" as const,
    runtimeProfileId,
    entrypoint: "main.py",
    content: "print('ok')",
    sha256: "a".repeat(64),
    inputs: {},
    outputs: {},
  },
  provenance: {},
  contentSha256: "a".repeat(64),
  createdBy: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function setupMocks() {
  const detail = {
    asset: {
      id: scriptId,
      kind: "sandbox-script",
      name: "Original name",
      version: "0.1.0",
      source: "sp-draft",
      lifecycle: "draft",
      visibility: "private",
      ownerUserId: "00000000-0000-4000-8000-000000000030",
      ownerOrgId: null,
      providerOrgId: null,
      payload: revision.payload,
      trustedForGlobalUse: false,
      sharedAccountEligible: false,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
    revisions: [revision],
    attestations: [],
  };
  sandboxClient.getSandboxScript.mockResolvedValue(detail);
  sandboxClient.listSandboxRuntimeProfiles.mockResolvedValue([
    {
      id: runtimeProfileId,
      name: "Python 3.12",
      language: "python",
      languageVersion: "3.12",
      ociDigest: `sha256:${"b".repeat(64)}`,
      sifDigest: null,
      signature: "test-signature",
      dependencies: [],
      documentation: {},
      adapters: ["slurm"],
      securityRequirements: {
        networkDisabled: true,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        seccompRequired: true,
        signatureVerificationRequired: true,
      },
      lifecycle: "active",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  ]);
  sandboxClient.createSandboxScriptRevision.mockResolvedValue({ ...revision, revision: 5 });
  sandboxClient.deleteSandboxScript.mockResolvedValue(undefined);
  return detail;
}

function renderStudio(id: string | null = scriptId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SandboxScriptStudio scriptId={id ?? undefined} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

afterEach(() => {
  vi.clearAllMocks();
  publishingAccess.canPublish = true;
  publishingAccess.ready = true;
});

describe("SandboxScriptStudio", () => {
  test("seeds the created asset detail before navigating to its IDE", async () => {
    const detail = setupMocks();
    sandboxClient.createSandboxScript.mockResolvedValue({
      asset: { ...detail.asset, name: "Created script" },
      revision,
    });
    const { client } = renderStudio(null);
    const nameField = screen.getByText("sandbox.studio.name").closest("fieldset");
    const nameInput = nameField?.querySelector("input");
    if (!nameInput) throw new Error("name input not found");
    fireEvent.change(nameInput, { target: { value: "Created script" } });
    const saveButton = screen.getByRole("button", { name: "sandbox.studio.save" });
    await waitFor(() => expect(saveButton.hasAttribute("disabled")).toBe(false));

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(client.getQueryData(["sandbox-script", scriptId])).toEqual({
        asset: { ...detail.asset, name: "Created script" },
        revisions: [revision],
        attestations: [],
      });
      expect(navigate).toHaveBeenCalledWith({
        to: "/software/scripts/$scriptId",
        params: { scriptId },
      });
    });
  });

  test("persists the edited asset name when creating a revision", async () => {
    setupMocks();
    renderStudio();

    const nameInput = await screen.findByDisplayValue("Original name");
    fireEvent.change(nameInput, { target: { value: "Renamed script" } });
    fireEvent.click(screen.getByRole("button", { name: "sandbox.studio.newRevision" }));

    await waitFor(() => {
      expect(sandboxClient.createSandboxScriptRevision).toHaveBeenCalledWith(
        scriptId,
        expect.objectContaining({ name: "Renamed script", version: "0.1.0" }),
      );
    });
  });

  test("requires confirmation before deleting a draft and returns to the catalog", async () => {
    setupMocks();
    renderStudio();

    await screen.findByDisplayValue("Original name");
    fireEvent.click(screen.getByRole("button", { name: "sandbox.studio.delete" }));
    expect(sandboxClient.deleteSandboxScript).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "sandbox.studio.confirmDelete" }));

    await waitFor(() => {
      expect(sandboxClient.deleteSandboxScript).toHaveBeenCalledWith(scriptId);
      expect(navigate).toHaveBeenCalledWith({ to: "/software", hash: "scripts" });
    });
  });

  test("hides revision and delete mutations from a catalog reader", async () => {
    publishingAccess.canPublish = false;
    setupMocks();
    renderStudio();

    await screen.findByDisplayValue("Original name");
    expect(screen.queryByRole("button", { name: "sandbox.studio.newRevision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "sandbox.studio.delete" })).toBeNull();
  });
});
