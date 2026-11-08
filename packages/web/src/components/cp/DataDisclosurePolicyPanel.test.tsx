import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { DataDisclosurePolicyPanel } from "./DataDisclosurePolicyPanel";

const state = vi.hoisted(() => ({ revision: "session-1", readOnly: false }));
vi.mock("../../lib/auth", () => ({
  getAuthState: () => ({ revision: state.revision }),
  subscribeAuthState: () => () => {},
}));
vi.mock("../../lib/api-client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => state.readOnly,
}));
const empty = {
  policy: null,
  editable: true,
  canApprove: true,
  otherPolicies: [],
  hasMorePolicies: false,
};
const policy = {
  id: "policy-1",
  status: "active",
  updatedAt: "2026-11-08T01:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  reason: "Owner approval",
  subjectKind: "org",
  effect: "allow",
  downloadPolicy: "allow",
  redistributionPolicy: "allow",
  crossCenterReplicationPolicy: "allow",
};
const path = "/cp/data/versions/version-1/disclosure-policy";
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (org: string, version = "version-1") => (
    <QueryClientProvider client={client}>
      <DataDisclosurePolicyPanel organizationId={org} versionId={version} />
    </QueryClientProvider>
  );
  const view = render(element("org-1"));
  return {
    ...view,
    client,
    switchTo: (org: string, version?: string) => view.rerender(element(org, version)),
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.revision = "session-1";
  state.readOnly = false;
  await i18n.changeLanguage("zh");
  vi.mocked(api.get).mockResolvedValue({ data: empty });
  vi.mocked(api.post).mockResolvedValue({ success: true });
});
function fill() {
  fireEvent.change(screen.getByLabelText("有效期至"), { target: { value: "2099-01-01T12:00" } });
  fireEvent.change(screen.getByLabelText("授权或撤销原因"), {
    target: { value: "Approved for research cooperation" },
  });
}

test("approves only the selected version with a pinned organization/login and current revision", async () => {
  mount();
  await screen.findByRole("button", { name: "允许跨机构复制" });
  fill();
  fireEvent.click(screen.getByRole("button", { name: "允许跨机构复制" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      path,
      {
        enabled: true,
        expectedUpdatedAt: null,
        expiresAt: new Date("2099-01-01T12:00").toISOString(),
        reason: "Approved for research cooperation",
      },
      { organizationId: "org-1", authRevision: "session-1" },
    ),
  );
  await waitFor(() => expect(screen.getByLabelText("授权或撤销原因")).toHaveProperty("value", ""));
});

test("revocation retains the loaded revision and works without entering a new expiry", async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { ...empty, policy } });
  mount();
  await screen.findByRole("button", { name: "撤销授权" });
  fireEvent.change(screen.getByLabelText("授权或撤销原因"), {
    target: { value: "Owner withdrew approval" },
  });
  fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      path,
      {
        enabled: false,
        expectedUpdatedAt: policy.updatedAt,
        expiresAt: policy.expiresAt,
        reason: "Owner withdrew approval",
      },
      { organizationId: "org-1", authRevision: "session-1" },
    ),
  );
});

test("unknown submission outcome blocks another write until a successful explicit refresh", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost"));
  mount();
  await screen.findByRole("button", { name: "允许跨机构复制" });
  fill();
  fireEvent.click(screen.getByRole("button", { name: "允许跨机构复制" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "允许跨机构复制" })).toHaveProperty("disabled", true);
  vi.mocked(api.get).mockResolvedValue({ data: { ...empty, policy } });
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByRole("button", { name: "更新有效期" });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("organization, version and login changes clear drafts and isolate cached policies", async () => {
  const view = mount();
  await screen.findByLabelText("授权或撤销原因");
  fill();
  view.switchTo("org-2");
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(path, {
      organizationId: "org-2",
      authRevision: "session-1",
    }),
  );
  expect(await screen.findByLabelText("授权或撤销原因")).toHaveProperty("value", "");
  fill();
  state.revision = "session-2";
  view.switchTo("org-2", "version-2");
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith("/cp/data/versions/version-2/disclosure-policy", {
      organizationId: "org-2",
      authRevision: "session-2",
    }),
  );
  expect(await screen.findByLabelText("授权或撤销原因")).toHaveProperty("value", "");
});

test("mobile read-only, mixed policies and unavailable versions cannot expose an approval action", async () => {
  state.readOnly = true;
  const view = mount();
  await screen.findByText("请在桌面端修改授权。");
  expect(screen.queryByRole("button", { name: "允许跨机构复制" })).toBeNull();
  state.readOnly = false;
  vi.mocked(api.get).mockResolvedValue({ data: { ...empty, editable: false } });
  view.switchTo("org-2");
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("授权或撤销原因")).toBeNull();
  vi.mocked(api.get).mockResolvedValue({ data: { ...empty, canApprove: false, policy } });
  view.switchTo("org-3");
  await screen.findByRole("button", { name: "更新有效期" });
  fill();
  expect(screen.getByRole("button", { name: "更新有效期" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "撤销授权" })).toHaveProperty("disabled", false);
});

test("load failures do not display stale policy data or enable edits", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("permission revoked"));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("授权或撤销原因")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("background updates do not rebase an already edited approval onto a newer policy", async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { ...empty, policy } });
  const { client } = mount();
  await screen.findByLabelText("授权或撤销原因");
  fill();
  vi.mocked(api.get).mockResolvedValue({
    data: { ...empty, policy: { ...policy, updatedAt: "2026-11-09T00:00:00.000Z" } },
  });
  await client.invalidateQueries({ queryKey: ["cp-data"] });
  fireEvent.click(screen.getByRole("button", { name: "更新有效期" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ expectedUpdatedAt: policy.updatedAt }),
      expect.anything(),
    ),
  );
});
