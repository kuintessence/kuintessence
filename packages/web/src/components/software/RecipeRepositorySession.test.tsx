import type { RecipeRepository } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AUTH_STATE_CHANGED_EVENT, clearAuth, setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import * as client from "../../lib/recipe-repositories-client";
import { RecipeRepositoriesPanel } from "./RecipeRepositoriesPanel";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: i18n.t.bind(i18n) }),
}));
vi.mock("../../lib/platform-capabilities", () => ({
  useMeCapabilities: (enabled: boolean) =>
    enabled
      ? {
          status: "ready",
          data: {
            principal: { userId: "alice", email: "alice@example.test", role: "platform_admin" },
            contexts: [],
            capabilities: ["software.publish"],
          },
        }
      : { status: "idle", data: null },
}));
vi.mock("../../lib/recipe-repositories-client", () => ({
  listRecipeRepositories: vi.fn(),
  getRecipeRepository: vi.fn(),
  importRecipeRepository: vi.fn(),
  activateRecipeRepository: vi.fn(),
  deactivateRecipeRepository: vi.fn(),
}));

const privateRepository: RecipeRepository = {
  id: "a".repeat(64),
  repository: "org/shared/alice-private",
  activeCommit: "b".repeat(40),
  snapshots: [
    {
      commit: "b".repeat(40),
      importedAt: "2026-09-17T00:00:00Z",
      importedBy: "alice",
      bundleSha256: "c".repeat(64),
      fileCount: 1,
      totalBytes: 100,
      roots: [],
      diagnostics: [{ severity: "warning", code: "PRIVATE", message: "Alice private diagnostic" }],
      validation: "static-only",
    },
  ],
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(canManage = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RecipeRepositoriesPanel canManage={canManage} />
    </QueryClientProvider>,
  );
  return queryClient;
}

function recipeQueries(queryClient: QueryClient) {
  return queryClient.getQueryCache().findAll({ queryKey: ["spack-recipe-repositories"] });
}

async function inspectPrivateRepository() {
  fireEvent.click(await screen.findByRole("button", { name: "Inspect org/shared/alice-private" }));
  await screen.findByText("Alice private diagnostic");
}

beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  setAuth({ email: "alice@example.test", role: "platform_admin" });
  localStorage.setItem("kq.lang", "en");
  await i18n.changeLanguage("en");
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([privateRepository]);
  vi.mocked(client.getRecipeRepository).mockResolvedValue(privateRepository);
});
afterEach(() => {
  cleanup();
  clearAuth();
});

test("logout reactively removes private list and detail caches without touching unrelated queries", async () => {
  const queryClient = mount();
  queryClient.setQueryData(["unrelated"], "keep");
  await inspectPrivateRepository();
  expect(recipeQueries(queryClient)).toHaveLength(2);

  await act(async () => clearAuth());

  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
  expect(screen.queryByRole("button", { name: "Inspect org/shared/alice-private" })).toBeNull();
  expect(recipeQueries(queryClient)).toHaveLength(0);
  expect(queryClient.getQueryData(["unrelated"])).toBe("keep");
  expect(client.listRecipeRepositories).toHaveBeenCalledTimes(1);
});

test("a new account in the same organization never sees the previous account's cached repositories", async () => {
  localStorage.setItem("kq_active_organization_id", "shared");
  const queryClient = mount();
  await inspectPrivateRepository();
  const previousKeys = recipeQueries(queryClient).map((query) => query.queryHash);
  const nextList = deferred<RecipeRepository[]>();
  vi.mocked(client.listRecipeRepositories).mockReturnValueOnce(nextList.promise);

  await act(async () => {
    clearAuth();
    setAuth({ email: "bob@example.test", role: "user" });
  });

  await waitFor(() => expect(client.listRecipeRepositories).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
  expect(screen.queryByRole("button", { name: "Inspect org/shared/alice-private" })).toBeNull();
  expect(recipeQueries(queryClient).some((query) => previousKeys.includes(query.queryHash))).toBe(
    false,
  );
  await act(async () => nextList.resolve([]));
  expect(await screen.findByText("No recipe repositories")).toBeTruthy();
});

test.each([
  "platform_admin",
  "user",
])("a same-email session refresh with role %s resets private caches and selected detail", async (role) => {
  const queryClient = mount();
  await inspectPrivateRepository();
  const previousKeys = recipeQueries(queryClient).map((query) => query.queryHash);
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([]);

  await act(async () => setAuth({ email: "alice@example.test", role }));

  expect(await screen.findByText("No recipe repositories")).toBeTruthy();
  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
  expect(recipeQueries(queryClient).some((query) => previousKeys.includes(query.queryHash))).toBe(
    false,
  );
  expect(client.listRecipeRepositories).toHaveBeenCalledTimes(2);
});

test("role changes with the same auth revision still invalidate recipe visibility", async () => {
  mount();
  await inspectPrivateRepository();
  vi.mocked(client.listRecipeRepositories).mockResolvedValue([]);
  await act(async () => {
    localStorage.setItem("kq_role", "user");
    window.dispatchEvent(new Event(AUTH_STATE_CHANGED_EVENT));
  });
  expect(await screen.findByText("No recipe repositories")).toBeTruthy();
  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
});

test("a late list response from an old session cannot repopulate the cache", async () => {
  const pending = deferred<RecipeRepository[]>();
  vi.mocked(client.listRecipeRepositories).mockReturnValueOnce(pending.promise);
  const queryClient = mount();
  await waitFor(() => expect(client.listRecipeRepositories).toHaveBeenCalledTimes(1));
  await act(async () => clearAuth());
  await act(async () => pending.resolve([privateRepository]));
  expect(recipeQueries(queryClient)).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Inspect org/shared/alice-private" })).toBeNull();
});

test("a late detail response from an old session cannot repopulate the cache", async () => {
  const pending = deferred<RecipeRepository>();
  vi.mocked(client.getRecipeRepository).mockReturnValueOnce(pending.promise);
  const queryClient = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect org/shared/alice-private" }));
  await waitFor(() => expect(client.getRecipeRepository).toHaveBeenCalledTimes(1));
  await act(async () => clearAuth());
  await act(async () => pending.resolve(privateRepository));
  expect(recipeQueries(queryClient)).toHaveLength(0);
  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
});

test("logout stops the queue and discards a late import result instead of recreating private caches", async () => {
  const pending = deferred<RecipeRepository>();
  vi.mocked(client.importRecipeRepository)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(privateRepository);
  const queryClient = mount(true);
  await screen.findByRole("button", { name: "Inspect org/shared/alice-private" });
  fireEvent.change(screen.getByLabelText("Git bundles"), {
    target: {
      files: [new File(["bundle"], "first.bundle"), new File(["bundle"], "second.bundle")],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import bundles" }));
  await waitFor(() => expect(client.importRecipeRepository).toHaveBeenCalledTimes(1));
  await act(async () => clearAuth());
  await act(async () => pending.resolve(privateRepository));
  expect(client.importRecipeRepository).toHaveBeenCalledTimes(1);
  expect(recipeQueries(queryClient)).toHaveLength(0);
  expect(screen.queryByText("org/shared/alice-private")).toBeNull();
});

test("anonymous sessions do not request recipe data", async () => {
  clearAuth();
  const queryClient = mount();
  expect(client.listRecipeRepositories).not.toHaveBeenCalled();
  expect(recipeQueries(queryClient)).toHaveLength(0);
});

test("StrictMode retains live session queries while clearing them on logout", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RecipeRepositoriesPanel canManage={false} />
      </QueryClientProvider>
    </StrictMode>,
  );
  await inspectPrivateRepository();
  expect(recipeQueries(queryClient)).toHaveLength(2);
  await act(async () => clearAuth());
  expect(recipeQueries(queryClient)).toHaveLength(0);
  expect(screen.queryByText("Alice private diagnostic")).toBeNull();
});
