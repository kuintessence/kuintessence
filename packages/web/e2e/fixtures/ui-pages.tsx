import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { RuntimeAndMaterialPanel } from "../../src/components/software/EcosystemGovernancePanels";
import { SoftwarePage } from "../../src/components/software/SoftwarePage";
import { WorkflowsPage } from "../../src/components/workflows/WorkflowsPage";
import { setLang } from "../../src/lib/i18n";
import { setMobileManagementPolicy } from "../../src/lib/mobile-management-policy";

setLang("zh");
setMobileManagementPolicy(true);
localStorage.setItem("kq_active_organization_id", "demo-provider");
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    },
  },
});
const templates = [
  "多阶段材料计算与结果分析工作流",
  "Python 数据清理和统计分析",
  "GPU 模型训练与批量推理",
].map((name, index) => ({
  id: `demo-template-${index}`,
  name,
  version: "1.0.0",
  description: "演示模板：准备输入、执行计算，并汇总可复现的结果。",
  createdAt: "2026-01-01T08:00:00Z",
  tags: ["demo"],
  yamlContent: `name: demo
parameters: []
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: a
      name: 演示计算
      usecaseVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3301
      softwareVersionId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
      inputSlots:
        - type: Text
          descriptor: script
          from:
            expr: "'echo demo'"
  nodeRelations: []
`,
}));
client.setQueryData(["software-templates", 1, "", null], {
  templates,
  tags: ["demo"],
  page: 1,
  total: 3,
  hasNext: false,
});
client.setQueryData(["software-usecases", "demo-provider", 1, ""], {
  usecasePackages: [],
  total: 0,
});
client.setQueryData(["software-spack-catalog", "", "all", 1], { packages: [], total: 0 });
client.setQueryData(["software-access-requests", "mine"], []);
client.setQueryData(["workflow-drafts"], { drafts: [] });
client.setQueryData(["workflows-list", { offset: 0, search: "", status: "ALL" }], {
  runs: [
    {
      id: "demo-run-1",
      name: "演示材料计算",
      status: "completed",
      createdAt: "2026-01-01T08:00:00Z",
    },
    { id: "demo-run-2", name: "演示数据分析", status: "failed", createdAt: "2026-01-01T09:00:00Z" },
  ],
  total: 2,
});
client.setQueryData(
  ["runtime-binding-agents", "demo-provider"],
  [
    {
      agentId: "demo-agent",
      providerOrgId: "demo-provider",
      siteName: "演示 Slurm 集群",
      schedulerType: "slurm",
    },
  ],
);
client.setQueryData(
  ["runtime-binding-profiles", "demo-provider"],
  [
    {
      id: "demo-profile",
      name: "Python 3.12",
      language: "python",
      languageVersion: "3.12.4",
      lifecycle: "active",
      adapters: ["slurm"],
      sifDigest: "sha256:demo",
    },
  ],
);
client.setQueryData(
  ["runtime-contract-bindings", "demo-provider"],
  [
    {
      runtimeContractRef: "python-3.12-stdlib-v1",
      runtimeProfileId: "demo-profile",
      agentId: "demo-agent",
    },
  ],
);
client.setQueryData(
  ["licensed-material-mappings", "demo-provider"],
  [
    {
      selector: "demo-local-pbe",
      materialVersion: "2025",
      elementSet: ["Si", "O"],
      agentId: "demo-agent",
    },
  ],
);
client.setQueryData(["licensed-material-software", "demo-provider", 1], {
  packages: [],
  hasNext: false,
});

function Shell() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-card p-6 md:block">
        KQ · 演示工作区
      </aside>
      <main className="min-w-0 p-4 md:ml-64 md:p-6">
        <p className="mb-4 text-xs text-muted-foreground">页面回归夹具 · 以下均为演示数据</p>
        <Outlet />
      </main>
    </>
  );
}
const rootRoute = createRootRoute({ component: Shell });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/software", component: SoftwarePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/workflows", component: WorkflowsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/runtime",
    component: () => <RuntimeAndMaterialPanel canManage />,
  }),
]);
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [location.pathname] }),
});
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
