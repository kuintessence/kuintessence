import { createHash } from "node:crypto";
import type {
  MeCapabilities,
  RecipeRepository,
  SpackUpstreamImport,
  SpackUpstreamImportResult,
} from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearAuth, setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import * as recipes from "../../lib/recipe-repositories-client";
import { SoftwareError } from "../../lib/software-client";
import * as materials from "../../lib/spack-materials-client";
import * as upstream from "../../lib/spack-upstream-client";
import recipesEn from "../../locales/recipes.en.json";
import recipesZh from "../../locales/recipes.zh.json";
import { RecipeRepositoriesPanel } from "./RecipeRepositoriesPanel";
import {
  capabilities,
  deferred,
  materialFixture,
  resetMaterials,
  translation,
} from "./SpackMaterials.test-helpers";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";
import { SpackOnlineImport } from "./SpackOnlineImport";

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
vi.mock("../../lib/spack-upstream-client", async (original) => ({
  ...(await original<typeof import("../../lib/spack-upstream-client")>()),
  importSpackUpstream: vi.fn(),
}));
vi.mock("../../lib/recipe-repositories-client", () => ({
  listRecipeRepositories: vi.fn(),
  getRecipeRepository: vi.fn(),
  importRecipeRepository: vi.fn(),
  activateRecipeRepository: vi.fn(),
  deactivateRecipeRepository: vi.fn(),
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

type Kind = SpackUpstreamImport["kind"];
const kinds: Kind[] = ["recipe", "material"];
const row: RecipeRepository = {
  id: "a".repeat(64),
  repository: "public/online-recipes",
  activeCommit: null,
  snapshots: [],
};

function manifest(kind: Kind, repository?: string): SpackUpstreamImport {
  if (kind === "recipe") {
    return {
      kind,
      repository: repository ?? row.repository,
      url: "https://downloads.example.test/recipes.bundle",
      digest: `sha256:${"b".repeat(64)}`,
      size: 100,
    };
  }
  const fixture = materialFixture(repository);
  const release = fixture.pack.releases[0];
  if (!release) throw new Error("Missing material release fixture");
  return {
    kind,
    files: [
      { url: "https://downloads.example.test/source.tar.gz", blob: fixture.source },
      { url: "https://downloads.example.test/spack.lock", blob: fixture.lock },
    ],
    release,
  };
}

function receipt(kind: Kind): SpackUpstreamImportResult {
  return kind === "recipe"
    ? { kind, repository: row }
    : { kind, binding: materialFixture().binding };
}

function mount(kind: Kind, strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const panel =
    kind === "recipe" ? <RecipeRepositoriesPanel canManage /> : <SpackMaterialsPanel canManage />;
  const content = () => (
    <QueryClientProvider client={client}>
      {strict ? <StrictMode>{panel}</StrictMode> : panel}
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, refresh: () => view.rerender(content()) };
}

function selectFile(kind: Kind, file: File) {
  fireEvent.change(screen.getByLabelText(`Choose online ${kind} manifest (JSON)`), {
    target: { files: [file] },
  });
}

async function select(kind: Kind, value: unknown = manifest(kind)) {
  selectFile(kind, new File([JSON.stringify(value)], "online.json"));
  await screen.findByText("Online import ready");
}

function start(kind: Kind) {
  fireEvent.click(
    screen.getByRole("button", {
      name: kind === "recipe" ? "Import recipes online" : "Import materials online",
    }),
  );
}

beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem("kq_active_organization_id", "org-a");
  access.status = "ready";
  access.data = capabilities();
  vi.mocked(recipes.listRecipeRepositories).mockResolvedValue([]);
  vi.mocked(recipes.getRecipeRepository).mockResolvedValue(row);
  vi.mocked(upstream.importSpackUpstream).mockImplementation(async (input) => receipt(input.kind));
});
afterEach(() => {
  cleanup();
  clearAuth();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(kinds)("%s submits explicitly and opens the existing detail", async (kind) => {
  mount(kind);
  const value = manifest(kind);
  await select(kind, value);
  expect(upstream.importSpackUpstream).not.toHaveBeenCalled();
  expect(screen.queryByText(/https:\/\//)).toBeNull();
  start(kind);
  await screen.findByText("Online import confirmed");
  expect(upstream.importSpackUpstream).toHaveBeenCalledExactlyOnceWith(
    value,
    expect.any(AbortSignal),
  );
  if (kind === "recipe") {
    await screen.findByRole("heading", { name: row.repository });
    const inspect = screen.getByRole("button", { name: `Inspect ${row.repository}` });
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
    expect(recipes.activateRecipeRepository).not.toHaveBeenCalled();
  } else {
    await screen.findByTestId("material-release-detail");
    expect(materials.getSpackMaterial).toHaveBeenCalledExactlyOnceWith(
      materialFixture().binding,
      expect.any(AbortSignal),
    );
    expect(materials.uploadSpackMaterial).not.toHaveBeenCalled();
    expect(materials.publishSpackMaterial).not.toHaveBeenCalled();
  }
});

test.each(kinds)("%s rejects malformed manifests and the other panel's kind", async (kind) => {
  mount(kind);
  const wrongKind = manifest(kind === "recipe" ? "material" : "recipe");
  for (const content of ["{", JSON.stringify(wrongKind)]) {
    selectFile(kind, new File([content], "invalid.json"));
    await screen.findByText(recipesEn.spackOnline.invalid);
    start(kind);
  }
  expect(upstream.importSpackUpstream).not.toHaveBeenCalled();
});

test.each(kinds)("%s blocks cross-namespace organization imports", async (kind) => {
  access.data = capabilities("org_admin");
  mount(kind);
  for (const repository of ["public/private", "org/org-b/private", "user/alice/private"]) {
    selectFile(kind, new File([JSON.stringify(manifest(kind, repository))], "online.json"));
    await screen.findByText(recipesEn.spackOnline.denied);
    start(kind);
  }
  expect(upstream.importSpackUpstream).not.toHaveBeenCalled();
});

test.each(kinds)("%s cancellation is unknown and ignores a late success", async (kind) => {
  const pending = deferred<SpackUpstreamImportResult>();
  vi.mocked(upstream.importSpackUpstream).mockReturnValueOnce(pending.promise);
  mount(kind);
  await select(kind);
  start(kind);
  const signal = vi.mocked(upstream.importSpackUpstream).mock.calls[0]?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Cancel online import" }));
  expect(signal?.aborted).toBe(true);
  expect(screen.getByText(recipesEn.spackOnline.unknown)).toBeTruthy();
  await act(async () => pending.resolve(receipt(kind)));
  expect(screen.queryByText("Online import confirmed")).toBeNull();
  expect(screen.queryByRole("heading", { name: row.repository })).toBeNull();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(upstream.importSpackUpstream).toHaveBeenCalledTimes(1);
});

test.each([
  new TypeError("Lost https://downloads.example.test/private"),
  new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "https://proxy.example.test/secret"),
  new SoftwareError(503, "UNAVAILABLE", "https://proxy.example.test/secret"),
  new SoftwareError(408, "TIMEOUT", "https://downloads.example.test/private"),
])("response loss is unknown and never echoes URLs or retries", async (error) => {
  vi.mocked(upstream.importSpackUpstream).mockRejectedValueOnce(error);
  mount("recipe");
  await select("recipe");
  start("recipe");
  await screen.findByText(recipesEn.spackOnline.unknown);
  expect(screen.queryByText(/https:\/\//)).toBeNull();
  expect(upstream.importSpackUpstream).toHaveBeenCalledTimes(1);
});

test("a rejected request uses fixed copy without claiming rollback", async () => {
  vi.mocked(upstream.importSpackUpstream).mockRejectedValueOnce(
    new SoftwareError(403, "FORBIDDEN", "https://user:secret@proxy.example.test"),
  );
  mount("material");
  await select("material");
  start("material");
  await screen.findByText(recipesEn.spackOnline.failed);
  expect(screen.queryByText(/secret|https:\/\//)).toBeNull();
});

test.each(kinds)("%s treats a 409 unknown-result receipt as unknown, not failed", async (kind) => {
  vi.mocked(upstream.importSpackUpstream).mockRejectedValueOnce(
    new SoftwareError(
      409,
      "UPSTREAM_IMPORT_RESULT_UNKNOWN",
      "https://downloads.example.test/private",
    ),
  );
  mount(kind);
  await select(kind);
  start(kind);
  await screen.findByText(recipesEn.spackOnline.unknown);
  expect(screen.queryByText(recipesEn.spackOnline.failed)).toBeNull();
  expect(screen.queryByText("Online import confirmed")).toBeNull();
  expect(screen.queryByText(/https:\/\//)).toBeNull();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(recipes.getRecipeRepository).not.toHaveBeenCalled();
  expect(upstream.importSpackUpstream).toHaveBeenCalledTimes(1);
});

test.each([
  "matching",
  "unrelated",
])("real client accepts only a matching material repository receipt: %s", async (identity) => {
  const realClient = await vi.importActual<typeof upstream>("../../lib/spack-upstream-client");
  vi.mocked(upstream.importSpackUpstream).mockImplementationOnce(realClient.importSpackUpstream);
  const fixture = materialFixture();
  const repository = identity === "matching" ? fixture.manifest.repository : "org/other/materials";
  const binding = {
    ...fixture.binding,
    repositoryId: createHash("sha256").update(repository).digest("hex"),
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ kind: "material", binding }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount("material");
  await select("material");
  start("material");
  if (identity === "matching") {
    await screen.findByText("Online import confirmed");
    await screen.findByTestId("material-release-detail");
    expect(materials.getSpackMaterial).toHaveBeenCalledExactlyOnceWith(
      binding,
      expect.any(AbortSignal),
    );
  } else {
    await screen.findByText(recipesEn.spackOnline.unknown);
    expect(screen.queryByText("Online import confirmed")).toBeNull();
    expect(screen.queryByTestId("material-release-detail")).toBeNull();
    expect(screen.getByLabelText("Repository ID")).toHaveProperty("value", "");
    expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const changes = [
  "logout",
  "identity",
  "session",
  "organization",
  "capability",
  "loading",
  "unmount",
] as const;
const cases = kinds.flatMap((kind) => changes.map((change) => ({ kind, change })));

async function changeScope(change: (typeof changes)[number], view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "identity") setAuth({ email: "bob@example.test", role: "platform_admin" });
    if (change === "session") setAuth({ email: "alice@example.test", role: "platform_admin" });
    if (change === "organization") {
      localStorage.setItem("kq_active_organization_id", "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "capability") {
      access.data = { ...capabilities(), capabilities: [] };
      view.refresh();
    }
    if (change === "loading") {
      access.status = "loading";
      view.refresh();
    }
    if (change === "unmount") view.unmount();
  });
}

test.each(cases)("$kind $change aborts and clears a pending import", async ({ kind, change }) => {
  const pending = deferred<SpackUpstreamImportResult>();
  vi.mocked(upstream.importSpackUpstream).mockReturnValueOnce(pending.promise);
  const view = mount(kind, true);
  await select(kind);
  start(kind);
  const signal = vi.mocked(upstream.importSpackUpstream).mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(receipt(kind)));
  expect(screen.queryByText("Online import confirmed")).toBeNull();
  expect(screen.queryByText("Online import ready")).toBeNull();
  expect(screen.queryByText("Registry online import in progress")).toBeNull();
  expect(screen.queryByRole("heading", { name: row.repository })).toBeNull();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(upstream.importSpackUpstream).toHaveBeenCalledTimes(1);
});

test.each(cases)("$kind $change discards a late manifest read", async ({ kind, change }) => {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest(kind)));
  const file = new File([bytes], "online.json");
  const pending = deferred<ArrayBuffer>();
  vi.spyOn(file, "arrayBuffer").mockReturnValueOnce(pending.promise);
  const view = mount(kind);
  selectFile(kind, file);
  expect(screen.getByText("Validating online import manifest")).toBeTruthy();
  await changeScope(change, view);
  await act(async () => pending.resolve(bytes.buffer));
  expect(screen.queryByText("Online import ready")).toBeNull();
  expect(upstream.importSpackUpstream).not.toHaveBeenCalled();
});

test.each(kinds)("%s checks the current identity again before submitting", async (kind) => {
  mount(kind);
  await select(kind);
  // No event: the synchronous session guard must still notice the storage change.
  localStorage.setItem("kq_email", "bob@example.test");
  start(kind);
  expect(upstream.importSpackUpstream).not.toHaveBeenCalled();
});

test.each(kinds)("%s hides online writes under the mobile management policy", async (kind) => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  mount(kind);
  expect(screen.queryByLabelText(`Choose online ${kind} manifest (JSON)`)).toBeNull();
});

test("a cancelled file read cannot replace a newly selected manifest", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest("recipe")));
  const file = new File([bytes], "old.json");
  const pending = deferred<ArrayBuffer>();
  vi.spyOn(file, "arrayBuffer").mockReturnValueOnce(pending.promise);
  mount("recipe");
  selectFile("recipe", file);
  fireEvent.click(screen.getByRole("button", { name: "Cancel online import" }));
  await select("recipe", manifest("recipe", "public/new-recipes"));
  await act(async () => pending.resolve(bytes.buffer));
  start("recipe");
  expect(upstream.importSpackUpstream).toHaveBeenCalledWith(
    expect.objectContaining({ repository: "public/new-recipes" }),
    expect.any(AbortSignal),
  );
});

test("a failed success callback retains the confirmed import outcome", async () => {
  render(
    <SpackOnlineImport
      kind="recipe"
      isCurrent={() => true}
      canWriteRepository={() => true}
      onImported={async () => {
        throw new Error("https://private.example.test/detail");
      }}
    />,
  );
  await select("recipe");
  start("recipe");
  await screen.findByText(recipesEn.spackOnline.refreshFailed);
  expect(screen.getByText("Online import confirmed")).toBeTruthy();
  expect(screen.queryByText(recipesEn.spackOnline.unknown)).toBeNull();
  expect(screen.queryByText(/https:\/\//)).toBeNull();
});

test("online import translations have matching keys and interpolate only counts", async () => {
  expect(Object.keys(recipesEn.spackOnline).sort()).toEqual(
    Object.keys(recipesZh.spackOnline).sort(),
  );
  for (const key of Object.keys(recipesEn.spackOnline) as Array<
    keyof typeof recipesEn.spackOnline
  >) {
    expect(recipesEn.spackOnline[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(
      recipesZh.spackOnline[key].match(/\{\{\w+\}\}/g) ?? [],
    );
  }
  await i18n.changeLanguage("zh");
  mount("recipe");
  expect(screen.getByLabelText("选择 recipe 在线导入清单（JSON）")).toBeTruthy();
});
