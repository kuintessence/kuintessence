import type { MeCapabilities, SpackMaterialCatalog } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-materials-client";
import {
  capabilities,
  expectNoWrites,
  materialFixture,
  resetMaterials,
} from "./SpackMaterials.test-helpers";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";

const access = vi.hoisted(() => ({
  status: "ready",
  data: null as MeCapabilities | null,
}));
vi.mock("../../lib/platform-capabilities", () => ({
  useMeCapabilities: (enabled: boolean) => (enabled ? access : { status: "idle", data: null }),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: i18n.getFixedT(i18n.language) }),
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

function catalog(count = 1, repository = "public/materials"): SpackMaterialCatalog {
  const { binding, manifest } = materialFixture(repository);
  return {
    releases: Array.from({ length: count }, (_, index) => ({
      ...binding,
      manifestDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
      repository,
      spec: `source-${index}@1.0`,
      target: manifest.target,
      spackVersion: manifest.spackVersion,
      redistribution: "unrestricted",
      sourceCount: 7,
      totalBytes: 4096,
    })),
  };
}

beforeEach(async () => {
  await resetMaterials();
  access.data = capabilities();
});
afterEach(() => {
  cleanup();
  clearAuth();
  delete window.__KQ_LOCAL__;
  vi.restoreAllMocks();
});

function mount(canManage = true) {
  return render(<SpackMaterialsPanel canManage={canManage} />);
}

function search(repository: string) {
  fireEvent.change(screen.getByLabelText("Exact repository"), { target: { value: repository } });
  fireEvent.click(screen.getByRole("button", { name: "Search materials" }));
}

test("loads summaries automatically and opens the selected binding in the existing lookup", async () => {
  const data = catalog();
  vi.mocked(client.listSpackMaterials).mockResolvedValue(data);
  mount(false);
  const table = within(await screen.findByRole("table", { name: "Material catalog" }));
  expect(client.listSpackMaterials).toHaveBeenCalledExactlyOnceWith({}, expect.any(AbortSignal));
  expect(table.getByText("public/materials")).toBeTruthy();
  expect(table.getByText("source-0@1.0")).toBeTruthy();
  expect(table.getByText("linux-ubuntu24.04-x86_64")).toBeTruthy();
  expect(table.getByText("7")).toBeTruthy();
  expect(table.getByText("4096")).toBeTruthy();
  fireEvent.click(table.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  expect(client.getSpackMaterial).toHaveBeenCalledExactlyOnceWith(
    { repositoryId: "e".repeat(64), manifestDigest: `sha256:${"0".repeat(64)}` },
    expect.any(AbortSignal),
  );
  expectNoWrites();
});

test("paginates locally with twenty rows, fixed bounds, and no additional requests", async () => {
  vi.mocked(client.listSpackMaterials).mockResolvedValue(catalog(41));
  mount();
  const table = within(await screen.findByRole("table", { name: "Material catalog" }));
  expect(table.getAllByRole("row")).toHaveLength(21);
  expect(screen.getByText("1 / 3")).toBeTruthy();
  const previous = screen.getByRole("button", { name: "Previous materials" });
  const next = screen.getByRole("button", { name: "Next materials" });
  expect(previous).toHaveProperty("disabled", true);
  fireEvent.click(previous);
  fireEvent.click(next);
  expect(table.getByText("source-20@1.0")).toBeTruthy();
  expect(table.queryByText("source-0@1.0")).toBeNull();
  fireEvent.click(next);
  expect(screen.getByText("3 / 3")).toBeTruthy();
  expect(table.getAllByRole("row")).toHaveLength(2);
  expect(table.getByText("source-40@1.0")).toBeTruthy();
  expect(next).toHaveProperty("disabled", true);
  fireEvent.click(next);
  expect(screen.getByText("3 / 3")).toBeTruthy();
  fireEvent.click(previous);
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
});

test("filter, refresh and reset clear prior rows and reset the page when results shrink", async () => {
  vi.mocked(client.listSpackMaterials)
    .mockResolvedValueOnce(catalog(21))
    .mockResolvedValueOnce(catalog(21, "org/org-a/sources"))
    .mockResolvedValueOnce(catalog(1, "org/org-a/sources"))
    .mockResolvedValueOnce(catalog());
  mount();
  await screen.findByRole("table", { name: "Material catalog" });
  fireEvent.click(screen.getByRole("button", { name: "Next materials" }));
  search("org/org-a/sources");
  expect(screen.queryByText("source-20@1.0")).toBeNull();
  await screen.findByText("source-0@1.0");
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(client.listSpackMaterials).toHaveBeenNthCalledWith(
    2,
    { repository: "org/org-a/sources" },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next materials" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh materials" }));
  await screen.findByText("source-0@1.0");
  expect(screen.getByText("1 / 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next materials" })).toHaveProperty("disabled", true);
  expect(client.listSpackMaterials).toHaveBeenNthCalledWith(
    3,
    { repository: "org/org-a/sources" },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset material filter" }));
  await screen.findByText("public/materials");
  expect(screen.getByLabelText("Exact repository")).toHaveProperty("value", "");
  expect(client.listSpackMaterials).toHaveBeenNthCalledWith(4, {}, expect.any(AbortSignal));
});

test("invalid filters cannot fetch and an empty search restores the complete catalog", async () => {
  mount();
  await screen.findByText("No materials found");
  search("public/materials?other=secret");
  expect(screen.getByLabelText("Exact repository").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("button", { name: "Search materials" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Refresh materials" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
  search("");
  await screen.findByText("No materials found");
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(2);
  expect(client.listSpackMaterials).toHaveBeenLastCalledWith({}, expect.any(AbortSignal));
  expect(screen.queryByRole("button", { name: "Next materials" })).toBeNull();
});

test.each([
  { status: 401, code: "UNAUTHORIZED", message: "Your session has expired." },
  { status: 403, code: "FORBIDDEN", message: "Your account does not have permission" },
  {
    status: 503,
    code: "MATERIAL_CATALOG_LIMIT",
    message: "The catalog exceeds the query limit. Filter by repository and try again.",
  },
  { status: 503, code: "REGISTRY_UNREACHABLE", message: "Could not load material catalog" },
  { status: 502, code: "REGISTRY_INVALID_RESPONSE", message: "Could not load material catalog" },
])("a $status read error removes old rows and allows an explicit retry", async ({
  status,
  code,
  message,
}) => {
  vi.mocked(client.listSpackMaterials)
    .mockResolvedValueOnce(catalog())
    .mockRejectedValueOnce(new SoftwareError(status, code, "token=private-internal"))
    .mockResolvedValueOnce({ releases: [] });
  mount();
  await screen.findByText("source-0@1.0");
  fireEvent.click(screen.getByRole("button", { name: "Refresh materials" }));
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect(screen.queryByText("source-0@1.0")).toBeNull();
  expect(screen.queryByText("No materials found")).toBeNull();
  expect(screen.queryByText("token=private-internal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh materials" }));
  await screen.findByText("No materials found");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("language changes translate the catalog without refreshing or resetting its page", async () => {
  vi.mocked(client.listSpackMaterials).mockResolvedValue(catalog(21));
  const view = mount();
  await screen.findByText("source-0@1.0");
  fireEvent.click(screen.getByRole("button", { name: "Next materials" }));
  await act(async () => {
    await i18n.changeLanguage("zh");
  });
  view.rerender(<SpackMaterialsPanel canManage />);
  expect(screen.getByRole("table", { name: "材料目录" })).toBeTruthy();
  expect(screen.getByText("source-20@1.0")).toBeTruthy();
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
});

test("catalog limit errors are localized without disclosing server details or refetching", async () => {
  vi.mocked(client.listSpackMaterials).mockRejectedValue(
    new SoftwareError(503, "MATERIAL_CATALOG_LIMIT", "token=private-internal"),
  );
  const view = mount();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The catalog exceeds the query limit. Filter by repository and try again.",
  );
  await act(async () => {
    await i18n.changeLanguage("zh");
  });
  view.rerender(<SpackMaterialsPanel canManage />);
  expect(screen.getByRole("alert").textContent).toBe("目录超过查询上限，请按仓库筛选后重试。");
  expect(client.listSpackMaterials).toHaveBeenCalledTimes(1);
});

test("mobile write restrictions retain the read-only catalog and details", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  vi.mocked(client.listSpackMaterials).mockResolvedValue(catalog());
  mount();
  await screen.findByText("source-0@1.0");
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  await screen.findByTestId("material-release-detail");
  expectNoWrites();
});

test.each(["anonymous", "local"])("%s mode does not load the catalog", (mode) => {
  if (mode === "anonymous") clearAuth();
  else window.__KQ_LOCAL__ = { baseUrl: "http://localhost:19999" };
  mount();
  expect(client.listSpackMaterials).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Exact repository")).toBeNull();
});
