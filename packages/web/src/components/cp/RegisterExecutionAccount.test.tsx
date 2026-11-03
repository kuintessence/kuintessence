import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import { RegisterExecutionAccount } from "./RegisterExecutionAccount";

const clientApi = vi.hoisted(() => ({
  createSandboxExecutionAccount: vi.fn(),
  listSandboxAgentSecurityViews: vi.fn(),
}));
vi.mock("../../lib/sandbox-client", () => clientApi);
afterEach(() => vi.clearAllMocks());
function setup() {
  setLang("zh");
  clientApi.listSandboxAgentSecurityViews.mockResolvedValue([
    { agentId: "slurm", siteName: "Slurm Cluster", providerOrgId: "org-a", schedulerType: "slurm" },
    {
      agentId: "kube",
      siteName: "Kubernetes Cluster",
      providerOrgId: "org-a",
      schedulerType: "kubernetes",
    },
    { agentId: "other", siteName: "Other Cluster", providerOrgId: "org-b", schedulerType: "slurm" },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    saved = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <RegisterExecutionAccount providerOrgId="org-a" onClose={vi.fn()} onSaved={saved} />
    </QueryClientProvider>,
  );
  return { ...view, client, saved };
}
test("registers an existing Unix identity, only offers agents in this organization", async () => {
  const { unmount, client, saved } = setup();
  await screen.findByRole("option", { name: "Slurm Cluster · slurm (slurm)" });
  expect(screen.queryByRole("option", { name: /Other Cluster/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("接入代理"), { target: { value: "slurm" } });
  for (const [label, value] of [
    ["账号名称", "Analysis"],
    ["Unix 用户名", "researcher"],
    ["UID", "2000"],
    ["GID", "2000"],
    ["允许队列（逗号分隔）", "debug, batch, debug"],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(clientApi.createSandboxExecutionAccount).toHaveBeenCalledWith({
    providerOrgId: "org-a",
    agentId: "slurm",
    displayName: "Analysis",
    backendType: "unix",
    username: "researcher",
    uid: 2000,
    gid: 2000,
    allowedQueues: ["debug", "batch"],
    sharedService: false,
  });
  unmount();
  client.clear();
});
test("switching scheduler clears incompatible identity fields; failed registration keeps the form", async () => {
  const { unmount, client, saved } = setup();
  await screen.findByRole("option", { name: /Slurm Cluster/ });
  fireEvent.change(screen.getByLabelText("接入代理"), { target: { value: "slurm" } });
  fireEvent.change(screen.getByLabelText("Unix 用户名"), { target: { value: "old-user" } });
  fireEvent.change(screen.getByLabelText("接入代理"), { target: { value: "kube" } });
  expect(screen.queryByLabelText("Unix 用户名")).toBeNull();
  for (const [label, value] of [
    ["账号名称", "Pod"],
    ["Namespace", "compute"],
    ["Service Account", "runner"],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  clientApi.createSandboxExecutionAccount.mockRejectedValueOnce(new Error("Provider denied"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Namespace")).toHaveProperty("value", "compute");
  expect(clientApi.createSandboxExecutionAccount).toHaveBeenCalledWith({
    providerOrgId: "org-a",
    agentId: "kube",
    displayName: "Pod",
    backendType: "kubernetes",
    namespace: "compute",
    serviceAccount: "runner",
    sharedService: false,
  });
  unmount();
  client.clear();
});
