import type { InterconnectSnapshot } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resources } from "../../../e2e/fixtures/interconnect-resources";
import { setLang } from "../../lib/i18n";
import { nativeControl } from "../../lib/test-resource-field";
import { InterconnectDashboard } from "./InterconnectDashboard";
import { MetadataEditor } from "./MetadataEditor";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => null }));
vi.mock("../../lib/auth", () => ({
  subscribeAuthState: () => () => {},
  getAuthState: () => ({ revision: "review" }),
}));
vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => ({ allowed: true, ready: true, error: null }),
}));
vi.mock("../ThemeProvider", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("echarts-for-react", () => ({ default: () => null }));
vi.mock("./InterconnectMap", () => ({ InterconnectMap: () => null }));

const snapshot: InterconnectSnapshot = {
  centers: [],
  clusters: [],
  links: [],
  agents: [],
  organizations: [{ id: "00000000-0000-4000-8000-000000000001", name: "提供者" }],
  defaultView: null,
  generatedAt: "2026-11-01T00:00:00.000Z",
  canManage: true,
};

beforeEach(() => setLang("zh"));
afterEach(() => {
  vi.clearAllMocks();
  setLang("zh");
});

test.each([
  "provider",
  "operator",
] as const)("%s scopes center management and new-center ownership to the organization in the entry link", async (mode) => {
  const orgA = "00000000-0000-4000-8000-000000000001";
  const orgB = "00000000-0000-4000-8000-000000000002";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue({
    ...snapshot,
    organizations: [
      { id: orgA, name: "组织 A" },
      { id: orgB, name: "组织 B" },
    ],
    centers: [orgA, orgB].map((orgId) => ({
      id: `center-${orgId}`,
      orgId,
      updatedAt: snapshot.generatedAt,
      metadata: {
        name: `站点 ${orgId}`,
        country: "中国",
        province: "",
        city: "",
        longitude: null,
        latitude: null,
        status: "unknown",
      },
    })),
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <InterconnectDashboard mode={mode} organizationId={orgB} />
    </QueryClientProvider>,
  );
  await screen.findAllByText("组织 B");
  expect(screen.queryByText(`站点 ${orgA}`)).toBeNull();
  expect(screen.getByRole("link", { name: "全部组织" }).getAttribute("href")).toBe(
    mode === "operator" ? "/interconnect" : "/cp/interconnect",
  );
  fireEvent.click(screen.getByRole("button", { name: "新增可用区" }));
  const organization = nativeControl(
    screen.getByRole("combobox", { name: "所属算力中心" }),
  ) as HTMLSelectElement;
  expect(organization.value).toBe(orgB);
  expect(Array.from(organization.options, (option) => option.value)).toEqual([orgB]);
  expect(api.post).not.toHaveBeenCalled();
  unmount();
  client.clear();
});

test.each([
  "provider",
  "operator",
] as const)("%s closes a metadata editor on revocation and starts a fresh edit after regrant", async (mode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue(snapshot);
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <InterconnectDashboard mode={mode} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "新增可用区" }));
  fireEvent.change(nativeControl(screen.getByLabelText("名称")), {
    target: { value: "未保存草稿" },
  });

  api.get.mockResolvedValue({ ...snapshot, canManage: false });
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByTestId("interconnect-dashboard")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增可用区" })).toBeNull();

  api.get.mockResolvedValue(snapshot);
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  const add = await screen.findByRole("button", { name: "新增可用区" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(add);
  expect(nativeControl(screen.getByLabelText("名称"))).toHaveProperty("value", "");

  api.get.mockRejectedValue(new Error("资源读取失败"));
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  api.get.mockResolvedValue(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "新增可用区" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  unmount();
  client.clear();
});

test("language switching translates the editor without changing persisted compute types", async () => {
  setLang("en");
  const centerId = "00000000-0000-4000-8000-000000000002";
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <MetadataEditor
      target={{ kind: "clusters" }}
      snapshot={{
        ...snapshot,
        centers: [
          {
            id: centerId,
            orgId: "00000000-0000-4000-8000-000000000001",
            updatedAt: snapshot.generatedAt,
            metadata: {
              name: "Center A",
              country: "China",
              province: "",
              city: "",
              longitude: null,
              latitude: null,
              status: "unknown",
            },
          },
        ],
      }}
      onSave={onSave}
      onClose={() => {}}
      onDelete={vi.fn()}
    />,
  );
  expect(screen.getByRole("heading", { name: "Add cluster" })).toBeTruthy();
  fireEvent.change(nativeControl(screen.getByLabelText("Name")), {
    target: { value: "Cluster A" },
  });
  fireEvent.click(screen.getByLabelText("Domestic CPU"));
  fireEvent.click(screen.getByLabelText("Other"));
  await act(async () => setLang("zh"));
  expect(screen.getByLabelText("国产 CPU")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("其他")).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    centerId,
    metadata: {
      name: "Cluster A",
      computeTypes: ["国产 CPU", "其他"],
      cpuCores: null,
      storageBytes: null,
    },
  });
});

test("invalid metadata identifies the field in the selected language", () => {
  setLang("en");
  const onSave = vi.fn();
  render(
    <MetadataEditor
      target={{ kind: "centers" }}
      snapshot={snapshot}
      onSave={onSave}
      onClose={() => {}}
      onDelete={vi.fn()}
    />,
  );
  fireEvent.change(nativeControl(screen.getByLabelText("Name")), { target: { value: "Center A" } });
  fireEvent.change(nativeControl(screen.getByLabelText("Longitude")), { target: { value: "200" } });
  fireEvent.change(nativeControl(screen.getByLabelText("Latitude")), { target: { value: "40" } });
  const form = screen.getByRole("button", { name: "Save" }).closest("form");
  if (!form) throw new Error("Metadata form is missing");
  fireEvent.submit(form);
  expect(screen.getByRole("alert").textContent).toBe("Check these fields: Longitude");
  expect(onSave).not.toHaveBeenCalled();
});

vi.mock("../function-maps/FunctionMaps", () => ({
  FunctionMaps: ({
    dashboard,
    common,
  }: {
    dashboard?: import("react").ReactNode;
    common?: import("react").ReactNode;
  }) => (
    <>
      {common}
      {dashboard}
    </>
  ),
}));

for (const mode of ["operator", "provider"] as const) {
  test.each([
    "centers",
    "clusters",
    "links",
  ] as const)(`${mode} resource page %s filters and supports edit/delete`, async (resource) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.get.mockResolvedValue(resources);
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <InterconnectDashboard mode={mode} resource={resource} />
      </QueryClientProvider>,
    );
    const table = await screen.findByRole("table");
    const addLabel =
      resource === "centers" ? "新增可用区" : resource === "clusters" ? "新增集群" : "新增传输链路";
    fireEvent.click(screen.getByRole("button", { name: addLabel }));
    fireEvent.change(nativeControl(screen.getByLabelText("名称", { exact: true })), {
      target: { value: "新增资源" },
    });
    if (resource === "centers") {
      fireEvent.change(nativeControl(screen.getByLabelText("国家")), { target: { value: "中国" } });
    }
    if (resource === "links") {
      fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("链路类型"), {
        target: { value: "high-speed" },
      });
      for (const label of ["起点", "终点"]) {
        fireEvent.change(nativeControl(screen.getByRole("combobox", { name: label })), {
          target: { value: resources.centers[0]?.id },
        });
      }
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/interconnect/${mode}/${resource}`,
        expect.objectContaining({ metadata: expect.objectContaining({ name: "新增资源" }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByText("资源分布")).toBeNull();
    expect(screen.queryByText("查看数值")).toBeNull();
    const change = (label: string, value: string) =>
      fireEvent.change(nativeControl(screen.getByRole("combobox", { name: label })), {
        target: { value },
      });
    change("所属算力中心", resources.organizations[1]?.id ?? "");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table.textContent).toContain("广州");
    expect(table.textContent).not.toContain("北京");
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "北京" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    if (resource === "links") {
      change("链路类型", "dedicated");
      expect(within(table).queryAllByRole("row")).toHaveLength(1);
    } else {
      change("状态", "offline");
      expect(within(table).queryAllByRole("row")).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.click(within(table).getAllByRole("button", { name: "编辑" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(nativeControl(within(dialog).getByLabelText("名称", { exact: true })), {
      target: { value: "更新名称" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        `/interconnect/${mode}/${resource}/${resources[resource][0]?.id}`,
        expect.objectContaining({ metadata: expect.objectContaining({ name: "更新名称" }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(table).getAllByRole("button", { name: "编辑" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除档案" }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(
        `/interconnect/${mode}/${resource}/${resources[resource][0]?.id}`,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    unmount();
    client.clear();
  });
}

test("resource pagination returns to page one on search and hides mutations without management permission", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const center = resources.centers[0];
  if (!center) throw new Error("Missing fixture center");
  api.get.mockResolvedValue({
    ...resources,
    canManage: false,
    centers: Array.from({ length: 26 }, (_, i) => ({
      ...center,
      id: `center-${i}`,
      metadata: { ...center.metadata, name: `可用区 ${i}` },
    })),
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <InterconnectDashboard mode="operator" resource="centers" />
    </QueryClientProvider>,
  );
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(26);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "可用区 0" } });
  expect(table.textContent).toContain("可用区 0");
  expect(screen.getByText("共 1 条 · 第 1 / 1 页")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增可用区" })).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  unmount();
  client.clear();
});
