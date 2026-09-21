import type { SpackMaterialManagementCatalog } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-material-management-client";
import { labels, lifecycleFixture } from "./MaterialLifecycle.test-helpers";
import { MaterialManagementCatalog } from "./MaterialManagementCatalog";
import { deferred } from "./SpackMaterials.test-helpers";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: i18n.getFixedT(i18n.language) }),
}));
vi.mock("../../lib/spack-material-management-client", () => ({
  listSpackMaterialManagement: vi.fn(),
}));

const repository = "org/org-a/materials";
const token = (value: string) => `v1.${value.repeat(64)}`;
const f = lifecycleFixture(repository);
function catalog(nextCursor: string | null = null): SpackMaterialManagementCatalog {
  return {
    releases: f.catalog.releases.map((release) => ({
      ...release,
      state: "withdrawn",
      revision: 1,
    })),
    nextCursor,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(client.listSpackMaterialManagement).mockResolvedValue(catalog());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const props = {
    isCurrent: vi.fn(() => true),
    canInspectRepository: vi.fn((name: string) => name === repository),
    onManage: vi.fn(),
    onFilterChange: vi.fn(),
    inspectionDisabled: false,
  };
  const view = render(<MaterialManagementCatalog {...props} />);
  return { ...view, props };
}

function search() {
  fireEvent.change(screen.getByLabelText(labels.managementRepository), {
    target: { value: repository },
  });
  fireEvent.click(screen.getByRole("button", { name: labels.managementSearch }));
}

test("requires an explicit manageable repository and search, with all/10 defaults", async () => {
  const { props } = mount();
  expect(client.listSpackMaterialManagement).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: labels.managementSearch })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByLabelText(labels.managementState)).toHaveProperty("value", "all");
  expect(screen.getByLabelText(labels.managementPageSize)).toHaveProperty("value", "10");
  expect(
    within(screen.getByLabelText(labels.managementPageSize))
      .getAllByRole("option")
      .map((option) => option.getAttribute("value")),
  ).toEqual(["1", "5", "10", "20"]);
  search();
  const table = within(await screen.findByRole("table", { name: labels.managementTitle }));
  expect(table.getByText(labels.lifecycleState.withdrawn)).toBeTruthy();
  expect(table.getByText(f.binding.manifestDigest)).toBeTruthy();
  expect(client.listSpackMaterialManagement).toHaveBeenCalledExactlyOnceWith(
    { repository, state: "all", limit: 10 },
    expect.any(AbortSignal),
  );
  fireEvent.click(table.getByRole("button", { name: labels.managementManage }));
  expect(props.onManage).toHaveBeenCalledExactlyOnceWith(f.binding);
});

test.each([
  "",
  "public/materials?state=all",
  "org/org-b/private",
])("does not request invalid or forbidden repository %s, even on form submission", (name) => {
  mount();
  const input = screen.getByLabelText(labels.managementRepository);
  fireEvent.change(input, { target: { value: name } });
  const form = input.closest("form");
  if (!form) throw new Error("Missing management form");
  fireEvent.submit(form);
  expect(client.listSpackMaterialManagement).not.toHaveBeenCalled();
});

test("uses opaque cursor history across empty filtered pages and refetches previous pages", async () => {
  vi.mocked(client.listSpackMaterialManagement)
    .mockResolvedValueOnce({ releases: [], nextCursor: token("z") })
    .mockResolvedValueOnce({ releases: [], nextCursor: token("a") })
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce({ releases: [], nextCursor: token("a") })
    .mockResolvedValueOnce({ releases: [], nextCursor: token("z") });
  mount();
  fireEvent.change(screen.getByLabelText(labels.managementState), {
    target: { value: "withdrawn" },
  });
  fireEvent.change(screen.getByLabelText(labels.managementPageSize), { target: { value: "1" } });
  search();
  await screen.findByText(labels.managementEmpty);
  const next = () => screen.getByRole("button", { name: labels.managementNext });
  const previous = () => screen.getByRole("button", { name: labels.managementPrevious });
  expect(previous()).toHaveProperty("disabled", true);
  expect(next()).toHaveProperty("disabled", false);
  fireEvent.click(next());
  await screen.findByText("Page 2");
  fireEvent.click(next());
  await screen.findByText("Page 3");
  expect(next()).toHaveProperty("disabled", true);
  fireEvent.click(previous());
  await screen.findByText("Page 2");
  fireEvent.click(previous());
  await screen.findByText("Page 1");
  expect(client.listSpackMaterialManagement).toHaveBeenCalledTimes(5);
  expect(vi.mocked(client.listSpackMaterialManagement).mock.calls.map(([query]) => query)).toEqual([
    { repository, state: "withdrawn", limit: 1 },
    { repository, state: "withdrawn", limit: 1, after: token("z") },
    { repository, state: "withdrawn", limit: 1, after: token("a") },
    { repository, state: "withdrawn", limit: 1, after: token("z") },
    { repository, state: "withdrawn", limit: 1, after: undefined },
  ]);
});

test.each([
  "repository",
  "state",
  "limit",
])("editing %s aborts pending reads, clears rows and cursors, and never searches automatically", async (field) => {
  const pending = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(client.listSpackMaterialManagement)
    .mockResolvedValueOnce(catalog(token("z")))
    .mockReturnValueOnce(pending.promise);
  const { props } = mount();
  search();
  await screen.findByRole("table", { name: labels.managementTitle });
  fireEvent.click(screen.getByRole("button", { name: labels.managementNext }));
  const signal = vi.mocked(client.listSpackMaterialManagement).mock.calls[1]?.[1];
  expect(screen.queryByRole("table")).toBeNull();
  const changes = {
    repository: [labels.managementRepository, "org/org-a/other"],
    state: [labels.managementState, "available"],
    limit: [labels.managementPageSize, "5"],
  };
  const change = changes[field as keyof typeof changes];
  const [label, value] = change;
  if (!label || !value) throw new Error("Missing filter change");
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(catalog()));
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByText(labels.managementLoading)).toBeNull();
  expect(screen.queryByRole("button", { name: labels.managementNext })).toBeNull();
  expect(client.listSpackMaterialManagement).toHaveBeenCalledTimes(2);
  expect(props.onFilterChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ [field]: field === "limit" ? 5 : value }),
  );
});

test.each([
  400, 401, 403, 422, 502, 503,
])("HTTP %i on a cursor page clears results and retries from page one", async (status) => {
  vi.mocked(client.listSpackMaterialManagement)
    .mockResolvedValueOnce(catalog(token("z")))
    .mockRejectedValueOnce(new SoftwareError(status, "CURSOR_INVALID", "token=private-detail"))
    .mockResolvedValueOnce(catalog());
  mount();
  search();
  await screen.findByRole("table", { name: labels.managementTitle });
  fireEvent.click(screen.getByRole("button", { name: labels.managementNext }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button", { name: labels.managementPrevious })).toBeNull();
  expect(screen.queryByText(/token=private-detail/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  await screen.findByText("Page 1");
  expect(client.listSpackMaterialManagement).toHaveBeenLastCalledWith(
    { repository, state: "all", limit: 10 },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([
  "resolve",
  "reject",
])("superseded requests cannot %s over new results", async (outcome) => {
  const old = deferred<SpackMaterialManagementCatalog>();
  const latest = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(client.listSpackMaterialManagement)
    .mockImplementationOnce(async () => {
      const result = await old.promise;
      if (outcome === "reject") throw new Error("private old error");
      return result;
    })
    .mockReturnValueOnce(latest.promise);
  mount();
  search();
  const signal = vi.mocked(client.listSpackMaterialManagement).mock.calls[0]?.[1];
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  expect(signal?.aborted).toBe(true);
  await act(async () => old.resolve(catalog()));
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(labels.managementLoading)).toBeTruthy();
  await act(async () => latest.resolve({ releases: [], nextCursor: null }));
  expect(screen.getByText(labels.managementEmpty)).toBeTruthy();
});

test.each([
  "session",
  "repository",
])("%s guard is checked before and after calls and selections", async (guard) => {
  const pending = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(client.listSpackMaterialManagement).mockReturnValueOnce(pending.promise);
  const { props } = mount();
  search();
  if (guard === "session") props.isCurrent.mockReturnValue(false);
  else props.canInspectRepository.mockReturnValue(false);
  await act(async () => pending.resolve(catalog()));
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  expect(client.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
  expect(props.onManage).not.toHaveBeenCalled();
});

test.each([
  "session",
  "repository",
  "locked",
  "edit",
  "refresh",
])("%s prevents selection of a previously rendered row", async (mode) => {
  const { props, rerender } = mount();
  search();
  await screen.findByRole("table", { name: labels.managementTitle });
  const button = screen.getByRole("button", { name: labels.managementManage });
  if (mode === "session") props.isCurrent.mockReturnValue(false);
  if (mode === "repository") props.canInspectRepository.mockReturnValue(false);
  if (mode === "locked") {
    rerender(<MaterialManagementCatalog {...props} inspectionDisabled />);
    expect(button).toHaveProperty("disabled", true);
  }
  if (mode === "edit") {
    fireEvent.change(screen.getByLabelText(labels.managementState), {
      target: { value: "available" },
    });
  }
  if (mode === "refresh") {
    vi.mocked(client.listSpackMaterialManagement).mockReturnValueOnce(
      deferred<SpackMaterialManagementCatalog>().promise,
    );
    fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  }
  fireEvent.click(button);
  expect(props.onManage).not.toHaveBeenCalled();
});

test("StrictMode never auto-loads a preserved filter and aborts on unmount", async () => {
  const pending = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(client.listSpackMaterialManagement).mockReturnValueOnce(pending.promise);
  const view = render(
    <StrictMode>
      <MaterialManagementCatalog
        isCurrent={() => true}
        canInspectRepository={() => true}
        onManage={vi.fn()}
        initialFilter={{ repository, state: "withdrawn", limit: 5 }}
      />
    </StrictMode>,
  );
  expect(client.listSpackMaterialManagement).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: labels.managementSearch }));
  const signal = vi.mocked(client.listSpackMaterialManagement).mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(catalog()));
});

test("language changes retain results without refetching", async () => {
  const { props, rerender } = mount();
  search();
  await screen.findByRole("table", { name: labels.managementTitle });
  await act(async () => {
    await i18n.changeLanguage("zh");
  });
  rerender(<MaterialManagementCatalog {...props} />);
  const table = within(screen.getByRole("table", { name: "维护者材料目录" }));
  expect(table.getByRole("cell", { name: /^已下架$/ })).toBeTruthy();
  expect(screen.getByLabelText("管理仓库")).toHaveProperty("value", repository);
  expect(client.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
});
