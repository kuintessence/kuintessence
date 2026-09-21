import type {
  MeCapabilities,
  SpackMaterialBlob,
  SpackMaterialManifest,
} from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearAuth, setAuth } from "../../lib/auth";
import * as client from "../../lib/spack-materials-client";
import {
  capabilities,
  confirmImport,
  deferred,
  expectNoWrites,
  findRelease,
  materialFixture,
  prepareImport,
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

const changes = ["logout", "same-email session", "organization", "capability revocation"] as const;
type ScopeChange = (typeof changes)[number];

function mount() {
  return render(<SpackMaterialsPanel canManage />);
}

async function changeScope(change: ScopeChange, view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "same-email session")
      setAuth({ email: "alice@example.test", role: "platform_admin" });
    if (change === "organization") {
      localStorage.setItem("kq_active_organization_id", "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "capability revocation") {
      access.data = { ...capabilities(), capabilities: [] };
      view.rerender(<SpackMaterialsPanel canManage />);
    }
  });
}

function expectPrivateStateCleared() {
  expect(screen.queryByRole("table", { name: "Material import queue" })).toBeNull();
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.queryByText("private-first@1.0")).toBeNull();
  expect(screen.queryByRole("button", { name: "Inspect release" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy release binding" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  for (const label of [
    "Repository ID",
    "Manifest digest",
    "Material manifest (JSON)",
    "Material files (flat paths)",
  ]) {
    const input = screen.queryByLabelText(label);
    if (input) expect(input).toHaveProperty("value", "");
  }
  const confirmation = screen.queryByRole("checkbox");
  if (confirmation) expect(confirmation).toHaveProperty("checked", false);
}

test.each(
  changes,
)("%s clears published rows, bindings, selected files and fetched private details", async (change) => {
  const f = materialFixture("org/org-a/private");
  vi.mocked(client.getSpackMaterial).mockResolvedValue(f.manifest);
  const view = mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);

  await changeScope(change, view);

  expectPrivateStateCleared();
  expect(client.getSpackMaterial).toHaveBeenCalledTimes(1);
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(1);
});

const importCases = changes.flatMap((change) => [
  { change, stage: "upload" as const },
  { change, stage: "publish" as const },
]);

test.each(
  importCases,
)("$change aborts pending $stage and ignores its late result without continuing the queue", async ({
  change,
  stage,
}) => {
  const f = materialFixture("org/org-a/private", 2);
  const upload = deferred<SpackMaterialBlob>();
  const publish = deferred<typeof f.binding>();
  if (stage === "upload") vi.mocked(client.uploadSpackMaterial).mockReturnValueOnce(upload.promise);
  else vi.mocked(client.publishSpackMaterial).mockReturnValueOnce(publish.promise);
  const view = mount();
  await prepareImport(f);
  confirmImport();
  await waitFor(() =>
    expect(
      stage === "upload" ? client.uploadSpackMaterial : client.publishSpackMaterial,
    ).toHaveBeenCalledTimes(1),
  );
  const signal =
    stage === "upload"
      ? vi.mocked(client.uploadSpackMaterial).mock.calls[0]?.[3]
      : vi.mocked(client.publishSpackMaterial).mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);

  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  expectPrivateStateCleared();
  await act(async () => {
    upload.resolve(f.lock);
    publish.resolve(f.binding);
  });

  expectPrivateStateCleared();
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(stage === "upload" ? 1 : 2);
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(stage === "upload" ? 0 : 1);
  expect(client.getSpackMaterial).not.toHaveBeenCalled();
});

test.each(
  changes,
)("%s aborts a private lookup and a late response cannot restore it", async (change) => {
  const f = materialFixture("org/org-a/private");
  const pending = deferred<SpackMaterialManifest>();
  vi.mocked(client.getSpackMaterial).mockReturnValueOnce(pending.promise);
  const view = mount();
  findRelease(f.binding);
  await waitFor(() => expect(client.getSpackMaterial).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(client.getSpackMaterial).mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);

  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  expectPrivateStateCleared();
  await act(async () => pending.resolve(f.manifest));

  expectPrivateStateCleared();
  expect(client.getSpackMaterial).toHaveBeenCalledTimes(1);
  expectNoWrites();
});

test.each(
  changes,
)("%s discards a manifest read that finishes in the old session", async (change) => {
  const f = materialFixture("org/org-a/private");
  const bytes = new TextEncoder().encode(JSON.stringify(f.pack));
  const file = new File([bytes], "private-manifest.json");
  const pending = deferred<ArrayBuffer>();
  vi.spyOn(file, "arrayBuffer").mockReturnValue(pending.promise);
  const view = mount();
  fireEvent.change(screen.getByLabelText("Material manifest (JSON)"), {
    target: { files: [file] },
  });
  expect(screen.getByText("Validating manifest")).toBeTruthy();

  await changeScope(change, view);
  await act(async () => pending.resolve(bytes.buffer));

  expectPrivateStateCleared();
  expect(screen.queryByText("Validating manifest")).toBeNull();
  expectNoWrites();
});

test("editing a lookup binding aborts the old request and cannot display its late result", async () => {
  const f = materialFixture("org/org-a/private");
  const pending = deferred<SpackMaterialManifest>();
  vi.mocked(client.getSpackMaterial).mockReturnValueOnce(pending.promise);
  mount();
  findRelease(f.binding);
  const signal = vi.mocked(client.getSpackMaterial).mock.calls[0]?.[1];
  fireEvent.change(screen.getByLabelText("Manifest digest"), {
    target: { value: `sha256:${"2".repeat(64)}` },
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(f.manifest));
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.getByRole("button", { name: "Find release" })).toHaveProperty("disabled", false);
  expect(client.getSpackMaterial).toHaveBeenCalledTimes(1);
});

test.each([
  "loading",
  "error",
] as const)("capabilities becoming %s abort an active import and clear prior confirmation", async (status) => {
  const f = materialFixture("org/org-a/private", 2);
  const pending = deferred<SpackMaterialBlob>();
  vi.mocked(client.uploadSpackMaterial).mockReturnValueOnce(pending.promise);
  const view = mount();
  await prepareImport(f);
  confirmImport();
  await waitFor(() => expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(client.uploadSpackMaterial).mock.calls[0]?.[3];
  access.status = status;
  view.rerender(<SpackMaterialsPanel canManage />);
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  await act(async () => pending.resolve(f.lock));
  access.status = "ready";
  await act(async () => view.rerender(<SpackMaterialsPanel canManage />));
  expectPrivateStateCleared();
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(1);
  expect(client.publishSpackMaterial).not.toHaveBeenCalled();
});

test("StrictMode retains a live import and aborts its request on unmount", async () => {
  const f = materialFixture();
  const pending = deferred<SpackMaterialBlob>();
  vi.mocked(client.uploadSpackMaterial).mockReturnValueOnce(pending.promise);
  const view = render(
    <StrictMode>
      <SpackMaterialsPanel canManage />
    </StrictMode>,
  );
  await prepareImport(f);
  confirmImport();
  await waitFor(() => expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(client.uploadSpackMaterial).mock.calls[0]?.[3];
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(f.lock));
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(1);
  expect(client.publishSpackMaterial).not.toHaveBeenCalled();
});
