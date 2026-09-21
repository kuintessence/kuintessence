import type { MeCapabilities, SpackMaterialCatalog } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearAuth, setAuth } from "../../lib/auth";
import * as client from "../../lib/spack-materials-client";
import {
  capabilities,
  deferred,
  expectNoWrites,
  materialFixture,
  resetMaterials,
  translation,
} from "./SpackMaterials.test-helpers";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";

const access = vi.hoisted(() => ({
  status: "ready" as "ready" | "loading" | "error",
  data: null as MeCapabilities | null,
}));
vi.mock("../../lib/platform-capabilities", () => ({
  useMeCapabilities: (enabled: boolean) => (enabled ? access : { status: "idle", data: null }),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

const privateCatalog: SpackMaterialCatalog = {
  releases: [
    {
      ...materialFixture().binding,
      repository: "org/org-a/private",
      spec: "private-source@1.0",
      target: "x86_64",
      spackVersion: "1.0.0",
      redistribution: "unrestricted",
      sourceCount: 1,
      totalBytes: 32,
    },
  ],
};

beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem("kq_active_organization_id", "org-a");
  access.status = "ready";
  access.data = capabilities();
});
afterEach(() => {
  cleanup();
  clearAuth();
  vi.restoreAllMocks();
});

function mount() {
  return render(<SpackMaterialsPanel canManage />);
}

test("inspecting the same row again restores its binding after a manual lookup edit", async () => {
  vi.mocked(client.listSpackMaterials).mockResolvedValueOnce(privateCatalog);
  mount();
  await screen.findByText("private-source@1.0");
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  fireEvent.change(screen.getByLabelText("Manifest digest"), {
    target: { value: `sha256:${"9".repeat(64)}` },
  });
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  expect(screen.getByLabelText("Manifest digest")).toHaveProperty(
    "value",
    materialFixture().binding.manifestDigest,
  );
  expect(client.getSpackMaterial).toHaveBeenLastCalledWith(
    materialFixture().binding,
    expect.any(AbortSignal),
  );
});

const changes = [
  "logout",
  "identity",
  "same-email session",
  "organization",
  "capability revocation",
  "capability loading",
  "capability error",
  "management",
] as const;

async function changeScope(change: (typeof changes)[number], view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "identity") setAuth({ email: "bob@example.test", role: "user" });
    if (change === "same-email session")
      setAuth({ email: "alice@example.test", role: "platform_admin" });
    if (change === "organization") {
      localStorage.setItem("kq_active_organization_id", "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "capability revocation") access.data = { ...capabilities(), capabilities: [] };
    if (change === "capability loading") access.status = "loading";
    if (change === "capability error") access.status = "error";
    view.rerender(<SpackMaterialsPanel canManage={change !== "management"} />);
  });
}

test.each(
  changes,
)("%s aborts catalog loading and suppresses late private responses", async (change) => {
  const pending = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials).mockReturnValueOnce(pending.promise);
  const view = mount();
  const signal = vi.mocked(client.listSpackMaterials).mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(privateCatalog));
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(change === "logout" ? 1 : 2);
  expectNoWrites();
});

test.each(changes)("%s clears loaded private rows, filters and selected detail", async (change) => {
  vi.mocked(client.listSpackMaterials).mockResolvedValueOnce(privateCatalog);
  const view = mount();
  await screen.findByText("private-source@1.0");
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  fireEvent.change(screen.getByLabelText("Exact repository"), {
    target: { value: "org/org-a/private" },
  });
  vi.mocked(client.listSpackMaterials).mockResolvedValueOnce(privateCatalog);
  fireEvent.click(screen.getByRole("button", { name: "Search materials" }));
  await screen.findByText("private-source@1.0");
  await changeScope(change, view);
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  const input = screen.queryByLabelText("Exact repository");
  if (input) expect(input).toHaveProperty("value", "");
});

test.each([
  "resolve",
  "reject",
])("a superseded request cannot %s over a newer pending request", async (outcome) => {
  const old = deferred<SpackMaterialCatalog>();
  const next = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials)
    .mockReturnValueOnce(
      old.promise.then((value) => {
        if (outcome === "reject") throw new Error("private-old-error");
        return value;
      }),
    )
    .mockReturnValueOnce(next.promise);
  mount();
  const oldSignal = vi.mocked(client.listSpackMaterials).mock.calls[0]?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Refresh materials" }));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => old.resolve(privateCatalog));
  expect(screen.getByText("Loading material catalog")).toBeTruthy();
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => next.resolve({ releases: [] }));
  expect(screen.getByText("No materials found")).toBeTruthy();
  expect(screen.queryByText("Loading material catalog")).toBeNull();
});

test("an older filtered result cannot replace a completed reset", async () => {
  const old = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials)
    .mockResolvedValueOnce({ releases: [] })
    .mockReturnValueOnce(old.promise);
  mount();
  await screen.findByText("No materials found");
  fireEvent.change(screen.getByLabelText("Exact repository"), {
    target: { value: "org/org-a/private" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search materials" }));
  const signal = vi.mocked(client.listSpackMaterials).mock.calls[1]?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Reset material filter" }));
  await screen.findByText("No materials found");
  expect(signal?.aborted).toBe(true);
  await act(async () => old.resolve(privateCatalog));
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  expect(screen.getByText("No materials found")).toBeTruthy();
});

test("editing a filter aborts its request without starting a search or retaining old results", async () => {
  const pending = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials).mockReturnValueOnce(pending.promise);
  mount();
  const signal = vi.mocked(client.listSpackMaterials).mock.calls[0]?.[1];
  fireEvent.change(screen.getByLabelText("Exact repository"), {
    target: { value: "org/org-a/private" },
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(privateCatalog));
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  expect(screen.queryByText("Loading material catalog")).toBeNull();
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
});

test("isCurrent blocks stale responses and commands before an organization rerender", async () => {
  const pending = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials).mockReturnValueOnce(pending.promise);
  mount();
  localStorage.setItem("kq_active_organization_id", "org-b");
  await act(async () => pending.resolve(privateCatalog));
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh materials" }));
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
});

test("isCurrent prevents selecting a stale visible catalog binding", async () => {
  vi.mocked(client.listSpackMaterials).mockResolvedValue(privateCatalog);
  mount();
  await screen.findByText("private-source@1.0");
  localStorage.setItem("kq_active_organization_id", "org-b");
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  expect(client.getSpackMaterial).not.toHaveBeenCalled();
});

test("StrictMode discards its first load and aborts the live request on unmount without caching", async () => {
  const first = deferred<SpackMaterialCatalog>();
  const second = deferred<SpackMaterialCatalog>();
  vi.mocked(client.listSpackMaterials)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = render(
    <StrictMode>
      <SpackMaterialsPanel canManage />
    </StrictMode>,
  );
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(2);
  expect(vi.mocked(client.listSpackMaterials).mock.calls[0]?.[1]?.aborted).toBe(true);
  const liveSignal = vi.mocked(client.listSpackMaterials).mock.calls[1]?.[1];
  expect(liveSignal?.aborted).toBe(false);
  await act(async () => first.resolve(privateCatalog));
  expect(screen.queryByText("private-source@1.0")).toBeNull();
  view.unmount();
  expect(liveSignal?.aborted).toBe(true);
  await act(async () => second.resolve(privateCatalog));
  mount();
  await screen.findByText("No materials found");
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(3);
  expect(screen.queryByText("private-source@1.0")).toBeNull();
});
