import type {
  MeCapabilities,
  RecipeRepository,
  RecipeSnapshot,
} from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import * as client from "../../lib/recipe-repositories-client";
import { SoftwareError } from "../../lib/software-client";
import recipesEn from "../../locales/recipes.en.json";
import recipesZh from "../../locales/recipes.zh.json";
import { RecipeRepositoriesPanel } from "./RecipeRepositoriesPanel";

const access = vi.hoisted(() => ({
  status: "ready" as "ready" | "loading" | "error",
  data: null as MeCapabilities | null,
}));

vi.mock("../../lib/platform-capabilities", () => ({
  useMeCapabilities: (enabled: boolean) => (enabled ? access : { status: "idle", data: null }),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: i18n.t.bind(i18n) }),
}));

vi.mock("../../lib/recipe-repositories-client", () => ({
  listRecipeRepositories: vi.fn(),
  getRecipeRepository: vi.fn(),
  importRecipeRepository: vi.fn(),
  activateRecipeRepository: vi.fn(),
  deactivateRecipeRepository: vi.fn(),
}));

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
function snapshot(commit: string): RecipeSnapshot {
  return {
    commit,
    importedAt: "2026-09-17T00:00:00Z",
    importedBy: "operator",
    bundleSha256: "c".repeat(64),
    fileCount: 12,
    totalBytes: 1234,
    roots: [{ path: "repos/builtin", namespace: "builtin", api: "v2.0", packageCount: 3 }],
    diagnostics: [
      {
        severity: "warning",
        code: "DYNAMIC_DEPENDENCY",
        message: "Conditional dependency requires concretization",
        path: "packages/demo/package.py",
        package: "demo",
      },
    ],
    validation: "static-only",
  };
}
function repository(activeCommit: string | null = newCommit): RecipeRepository {
  return {
    id: "d".repeat(64),
    repository: "public/builtin",
    activeCommit,
    snapshots: [snapshot(newCommit), snapshot(oldCommit)],
  };
}
function mount(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RecipeRepositoriesPanel canManage={canManage} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
async function openRepository() {
  fireEvent.click(await screen.findByRole("button", { name: "Inspect public/builtin" }));
  await screen.findByRole("table", { name: "Commit history" });
}
function selectFiles(...names: string[]) {
  const files = names.map((name) => new File(["bundle"], name));
  fireEvent.change(screen.getByLabelText("Git bundles"), { target: { files } });
  return files;
}

beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem("kq.lang", "en");
  localStorage.setItem("kq_session", "cookie");
  localStorage.setItem("kq_email", "operator@example.test");
  access.status = "ready";
  access.data = {
    principal: { userId: "operator-id", email: "operator@example.test", role: "platform_admin" },
    capabilities: ["software.publish"],
    contexts: [
      {
        id: "organization:org-a",
        type: "organization",
        organizationId: "org-a",
        membershipRole: "admin",
      },
      {
        id: "organization:org-b",
        type: "organization",
        organizationId: "org-b",
        membershipRole: "admin",
      },
    ],
    activeContextId: "platform",
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
  };
  await i18n.changeLanguage("en");
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(repository());
});
afterEach(() => cleanup());

test("distinguishes loading, empty, and load failure with retry", async () => {
  let resolveList: ((rows: RecipeRepository[]) => void) | undefined;
  vi.mocked(client.listRecipeRepositories).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveList = resolve;
    }),
  );
  mount();
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => resolveList?.([]));
  expect(await screen.findByText("No recipe repositories")).toBeTruthy();
  vi.mocked(client.listRecipeRepositories).mockRejectedValueOnce(
    new SoftwareError(503, "REGISTRY_UNREACHABLE", "offline"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh recipes" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("No recipe repositories")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh recipes" }));
  expect(await screen.findByText("No recipe repositories")).toBeTruthy();
});

test("uses per-file organization namespaces and uploads sequentially after a partial failure", async () => {
  localStorage.setItem("kq_active_organization_id", "org-a");
  let finishFirst: ((row: RecipeRepository) => void) | undefined;
  vi.mocked(client.importRecipeRepository)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockRejectedValueOnce(new SoftwareError(422, "INVALID_BUNDLE", "invalid"))
    .mockResolvedValueOnce({ ...repository(), id: "e".repeat(64), repository: "public/third" });
  mount();
  await screen.findByText("No recipe repositories");
  const files = selectFiles("first.bundle", "second.bundle", "third.bundle");
  expect(screen.getByLabelText("Repository for first.bundle")).toHaveProperty(
    "value",
    "org/org-a/first",
  );
  expect(screen.getByLabelText("Repository for second.bundle")).toHaveProperty(
    "value",
    "org/org-a/second",
  );
  fireEvent.change(screen.getByLabelText("Repository for third.bundle"), {
    target: { value: "public/third" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await waitFor(() => expect(client.importRecipeRepository).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Repository for second.bundle")).toHaveProperty("disabled", true);
  await act(async () => finishFirst?.({ ...repository(), repository: "org/org-a/first" }));
  await screen.findByText("2 imported, 1 failed");
  expect(client.importRecipeRepository).toHaveBeenNthCalledWith(1, "org/org-a/first", files[0]);
  expect(client.importRecipeRepository).toHaveBeenNthCalledWith(2, "org/org-a/second", files[1]);
  expect(client.importRecipeRepository).toHaveBeenNthCalledWith(3, "public/third", files[2]);
  expect(screen.getByRole("button", { name: "Inspect org/org-a/first" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Inspect public/third" })).toBeTruthy();
  vi.mocked(client.importRecipeRepository).mockResolvedValueOnce({
    ...repository(),
    id: "f".repeat(64),
    repository: "org/org-a/second",
  });
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await waitFor(() => expect(client.importRecipeRepository).toHaveBeenCalledTimes(4));
  expect(client.importRecipeRepository).toHaveBeenLastCalledWith("org/org-a/second", files[1]);
  await screen.findByText("3 imported, 0 failed");
});

test("rejects non-bundles and invalid or user namespaces without sending writes", async () => {
  mount();
  await screen.findByText("No recipe repositories");
  selectFiles("recipe.zip");
  expect(screen.getByRole("alert").textContent).toContain(".bundle");
  expect(screen.getByRole("button", { name: "Import bundles" })).toHaveProperty("disabled", true);
  selectFiles("valid.bundle");
  for (const invalid of ["", "public/../bad", "user/me/private", "org//name"]) {
    fireEvent.change(screen.getByLabelText("Repository for valid.bundle"), {
      target: { value: invalid },
    });
    expect(screen.getByRole("button", { name: "Import bundles" })).toHaveProperty("disabled", true);
  }
  expect(client.importRecipeRepository).not.toHaveBeenCalled();
});

test("renders full history, static diagnostics and boundaries without claiming Agent delivery", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  mount(false);
  await openRepository();
  expect(screen.getAllByText(oldCommit).length).toBeGreaterThan(0);
  expect(screen.getByText("DYNAMIC_DEPENDENCY")).toBeTruthy();
  expect(screen.getByText("packages/demo/package.py")).toBeTruthy();
  expect(screen.getByText("builtin")).toBeTruthy();
  expect(screen.getByText("v2.0")).toBeTruthy();
  expect(screen.getByText("Concretization: not run")).toBeTruthy();
  expect(screen.getByText("Agent delivery: not implemented")).toBeTruthy();
  expect(screen.queryByText(/Each file has its own destination/)).toBeNull();
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
  expect(screen.queryByRole("button", { name: /Activate|Roll back|Deactivate/ })).toBeNull();
});

test("requires fresh executable trust confirmation before activating and rolling back", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository(null)]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(repository(null));
  vi.mocked(client.activateRecipeRepository)
    .mockResolvedValueOnce(repository(newCommit))
    .mockResolvedValueOnce(repository(oldCommit));
  mount();
  await openRepository();
  fireEvent.click(screen.getByRole("button", { name: `Activate ${newCommit}` }));
  let dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("button", { name: "Confirm activation" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(client.activateRecipeRepository).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "Confirm activation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.activateRecipeRepository).toHaveBeenNthCalledWith(1, repository().id, {
    commit: newCommit,
    expectedActiveCommit: null,
    acknowledgeExecutableRecipes: true,
  });
  fireEvent.click(screen.getByRole("button", { name: `Roll back to ${oldCommit}` }));
  dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "Confirm activation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.activateRecipeRepository).toHaveBeenNthCalledWith(2, repository().id, {
    commit: oldCommit,
    expectedActiveCommit: newCommit,
    acknowledgeExecutableRecipes: true,
  });
});

test("deactivates with CAS while keeping every snapshot visible", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  vi.mocked(client.deactivateRecipeRepository).mockResolvedValue(repository(null));
  mount();
  await openRepository();
  fireEvent.click(screen.getByRole("button", { name: "Deactivate repository" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(/History is retained/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Confirm deactivation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.deactivateRecipeRepository).toHaveBeenCalledWith(repository().id, newCommit);
  expect(
    within(screen.getByRole("table", { name: "Commit history" })).getAllByRole("row"),
  ).toHaveLength(3);
});

test("a conflict invalidates stale state and requires another explicit confirmation", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  vi.mocked(client.activateRecipeRepository).mockRejectedValue(
    new SoftwareError(409, "CONFLICT", "changed"),
  );
  mount();
  await openRepository();
  vi.mocked(client.getRecipeRepository).mockResolvedValue(repository(oldCommit));
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository(oldCommit)]);
  fireEvent.click(screen.getByRole("button", { name: `Roll back to ${oldCommit}` }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() => expect(client.getRecipeRepository).toHaveBeenCalledTimes(2));
  await waitFor(() => {
    expect(
      within(screen.getByRole("table", { name: "Spack recipe repositories" })).queryByText(
        newCommit,
      ),
    ).toBeNull();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.activateRecipeRepository).toHaveBeenCalledTimes(1);
});

test("does not offer writes against a failed repository detail request", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  vi.mocked(client.getRecipeRepository).mockRejectedValue(new SoftwareError(403, "denied"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect public/builtin" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Deactivate repository" })).toBeNull();
});

test("organization switches reset upload destinations and selected repository", async () => {
  localStorage.setItem("kq_active_organization_id", "org-a");
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  mount();
  await openRepository();
  selectFiles("first.bundle");
  await act(async () => {
    localStorage.setItem("kq_active_organization_id", "org-b");
    window.dispatchEvent(new Event("kq:active-organization-change"));
  });
  expect(screen.queryByRole("table", { name: "Commit history" })).toBeNull();
  selectFiles("first.bundle");
  expect(screen.getByLabelText("Repository for first.bundle")).toHaveProperty(
    "value",
    "org/org-b/first",
  );
});

test("renders Chinese recipe copy", async () => {
  await i18n.changeLanguage("zh");
  mount();
  expect(await screen.findByText("暂无 recipe 仓库")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Spack recipe 仓库" })).toBeTruthy();
});

test("stops queued writes when the organization changes during an import", async () => {
  let finishFirst: ((row: RecipeRepository) => void) | undefined;
  vi.mocked(client.importRecipeRepository)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockResolvedValue(repository());
  localStorage.setItem("kq_active_organization_id", "org-a");
  mount();
  await screen.findByText("No recipe repositories");
  selectFiles("first.bundle", "second.bundle");
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await waitFor(() => expect(client.importRecipeRepository).toHaveBeenCalledTimes(1));
  await act(async () => {
    localStorage.setItem("kq_active_organization_id", "org-b");
    window.dispatchEvent(new Event("kq:active-organization-change"));
  });
  await act(async () => finishFirst?.(repository()));
  expect(client.importRecipeRepository).toHaveBeenCalledTimes(1);
});

test("reimporting the same repository updates rather than duplicates its row", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  vi.mocked(client.importRecipeRepository).mockResolvedValue(repository());
  mount();
  await screen.findByRole("button", { name: "Inspect public/builtin" });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    selectFiles("builtin.bundle");
    fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
    await screen.findByText("1 imported, 0 failed");
    expect(client.importRecipeRepository).toHaveBeenCalledTimes(attempt);
    expect(screen.getAllByRole("button", { name: "Inspect public/builtin" })).toHaveLength(1);
  }
  expect(client.activateRecipeRepository).not.toHaveBeenCalled();
});

test("warns explicitly when files share a destination and allows removal before import", async () => {
  mount();
  await screen.findByText("No recipe repositories");
  selectFiles("one.bundle", "two.bundle");
  fireEvent.change(screen.getByLabelText("Repository for two.bundle"), {
    target: { value: "public/one" },
  });
  expect(screen.getByText(/Multiple files target the same repository/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove two.bundle" }));
  expect(screen.queryByLabelText("Repository for two.bundle")).toBeNull();
  expect(screen.queryByText(/Multiple files target the same repository/)).toBeNull();
});

test("reads an older snapshot report and cancels activation without writing", async () => {
  const row = repository();
  row.snapshots[1] = { ...snapshot(oldCommit), diagnostics: [] };
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([row]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(row);
  mount();
  await openRepository();
  fireEvent.click(screen.getByRole("button", { name: `Inspect commit ${oldCommit}` }));
  expect(screen.getByText(/No static diagnostics reported/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Roll back to ${oldCommit}` }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.activateRecipeRepository).not.toHaveBeenCalled();
});

test("Chinese and English recipe messages have matching keys and interpolation fields", () => {
  expect(Object.keys(recipesEn.recipes).sort()).toEqual(Object.keys(recipesZh.recipes).sort());
  for (const key of Object.keys(recipesEn.recipes) as Array<keyof typeof recipesEn.recipes>) {
    expect(recipesEn.recipes[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(
      recipesZh.recipes[key].match(/\{\{\w+\}\}/g) ?? [],
    );
  }
});

test("an in-flight stale list response cannot hide a completed import", async () => {
  let finishList: ((rows: RecipeRepository[]) => void) | undefined;
  vi.mocked(client.listRecipeRepositories).mockReturnValueOnce(
    new Promise((resolve) => {
      finishList = resolve;
    }),
  );
  vi.mocked(client.importRecipeRepository).mockResolvedValue(repository());
  const { queryClient } = mount();
  selectFiles("builtin.bundle");
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await screen.findByText("1 imported, 0 failed");
  await act(async () => finishList?.([]));
  const list = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["spack-recipe-repositories"] })
    .find((query) => query.queryKey.at(-1) === "list");
  expect(list?.state.data).toEqual([repository()]);
  expect(screen.getByRole("button", { name: "Inspect public/builtin" })).toBeTruthy();
});

test.each([
  ["org_admin", "public/builtin", false],
  ["org_admin", "org/org-a/builtin", true],
  ["org_admin", "org/org-b/builtin", false],
  ["org_admin", "user/operator-id/builtin", false],
  ["platform_admin", "public/builtin", true],
  ["platform_admin", "org/org-a/builtin", true],
  ["platform_admin", "org/unknown/builtin", false],
  ["super_admin", "org/unknown/builtin", true],
  ["user", "org/org-a/builtin", false],
  ["operator", "public/builtin", false],
])("limits %s actions for %s to writable=%s", async (role, namespace, writable) => {
  if (!access.data) throw new Error("Missing capability fixture");
  access.data.principal.role = role;
  localStorage.setItem("kq_role", "super_admin");
  localStorage.setItem("kq_active_organization_id", "org-a");
  const row = { ...repository(), repository: namespace };
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([row]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(row);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: `Inspect ${namespace}` }));
  await screen.findByRole("table", { name: "Commit history" });
  expect(Boolean(screen.queryByRole("button", { name: "Deactivate repository" }))).toBe(writable);
  expect(Boolean(screen.queryByRole("button", { name: `Roll back to ${oldCommit}` }))).toBe(
    writable,
  );
  expect(Boolean(screen.queryByText("Read-only"))).toBe(!writable);
});

test.each([
  "loading",
  "error",
  "non-publisher",
  "non-member",
  "no-active-org",
])("fails closed for %s capability context despite broad manage access", async (state) => {
  if (!access.data) throw new Error("Missing capability fixture");
  access.data.principal.role = "org_admin";
  localStorage.setItem("kq_active_organization_id", "org-a");
  if (state === "loading" || state === "error") access.status = state;
  if (state === "non-publisher") access.data.capabilities = ["workspace.provider.manage"];
  if (state === "non-member") access.data.contexts = [];
  if (state === "no-active-org") localStorage.removeItem("kq_active_organization_id");
  const row = { ...repository(), repository: "org/org-a/builtin" };
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([row]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(row);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect org/org-a/builtin" }));
  await screen.findByRole("table", { name: "Commit history" });
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
  expect(screen.queryByRole("button", { name: /Activate|Roll back|Deactivate/ })).toBeNull();
});

test("validates every upload destination against namespace access", async () => {
  if (!access.data) throw new Error("Missing capability fixture");
  access.data.principal.role = "org_admin";
  localStorage.setItem("kq_active_organization_id", "org-a");
  mount();
  await screen.findByText("No recipe repositories");
  selectFiles("builtin.bundle");
  expect(screen.getByRole("button", { name: "Import bundles" })).toHaveProperty("disabled", false);
  for (const namespace of ["public/builtin", "org/org-b/builtin"]) {
    fireEvent.change(screen.getByLabelText("Repository for builtin.bundle"), {
      target: { value: namespace },
    });
    expect(screen.getByText("Read-only destination")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import bundles" })).toHaveProperty("disabled", true);
  }
  expect(client.importRecipeRepository).not.toHaveBeenCalled();
});

test("checks the fetched namespace, not only the namespace in the list", async () => {
  if (!access.data) throw new Error("Missing capability fixture");
  access.data.principal.role = "org_admin";
  localStorage.setItem("kq_active_organization_id", "org-a");
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([
    { ...repository(), repository: "org/org-a/builtin" },
  ]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(repository());
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect org/org-a/builtin" }));
  await screen.findByRole("table", { name: "Commit history" });
  expect(screen.queryByRole("button", { name: /Activate|Roll back|Deactivate/ })).toBeNull();
});

test("shows concise scope statuses instead of boundary and upload instructions", async () => {
  mount();
  await screen.findByText("No recipe repositories");
  expect(screen.getByText("Concretization: not run")).toBeTruthy();
  expect(screen.getByText("Agent delivery: not implemented")).toBeTruthy();
  expect(screen.queryByText(/Each file has its own destination/)).toBeNull();
  expect(screen.queryByText(/Static validation only\. Concretization/)).toBeNull();
});

test("closes executable trust confirmation when namespace write access is revoked", async () => {
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([repository()]);
  const { rerender, queryClient } = mount();
  await openRepository();
  fireEvent.click(screen.getByRole("button", { name: `Roll back to ${oldCommit}` }));
  fireEvent.click(screen.getByRole("checkbox"));
  if (!access.data) throw new Error("Missing capability fixture");
  access.data = { ...access.data, capabilities: [] };
  rerender(
    <QueryClientProvider client={queryClient}>
      <RecipeRepositoriesPanel canManage />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await openRepository();
  expect(screen.queryByRole("button", { name: /Activate|Roll back|Deactivate/ })).toBeNull();
  expect(client.activateRecipeRepository).not.toHaveBeenCalled();
});

test("stops unsent imports when publishing permission is revoked", async () => {
  let finishFirst: ((row: RecipeRepository) => void) | undefined;
  vi.mocked(client.importRecipeRepository)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockResolvedValue(repository());
  const { rerender, queryClient } = mount();
  await screen.findByText("No recipe repositories");
  selectFiles("first.bundle", "second.bundle");
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await waitFor(() => expect(client.importRecipeRepository).toHaveBeenCalledTimes(1));
  if (!access.data) throw new Error("Missing capability fixture");
  access.data = { ...access.data, capabilities: [] };
  rerender(
    <QueryClientProvider client={queryClient}>
      <RecipeRepositoriesPanel canManage />
    </QueryClientProvider>,
  );
  await act(async () => finishFirst?.(repository()));
  expect(client.importRecipeRepository).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
});
