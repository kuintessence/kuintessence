import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CpDashboard } from "../../src/components/cp/CpDashboard";
import { FunctionMaps } from "../../src/components/function-maps/FunctionMaps";
import { MapPreferencesPanel } from "../../src/components/function-maps/MapPreferencesPanel";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { NewWorkflowPage } from "../../src/components/workflows/NewWorkflowPage";
import { getAuthState, setAuth } from "../../src/lib/auth";
import { setLang } from "../../src/lib/i18n";

const params = new URLSearchParams(location.search);
setLang(params.get("lang") === "en" ? "en" : "zh");
setAuth({
  email: "visual-review@example.test",
  token: null,
  role: "super_admin",
  preserveRevision: true,
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
});
const yaml = `name: 序列分析演示
parameters:
  - name: sample
    type: string
    default: sample-01
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: prepare
      name: 数据预处理
      usecaseVersionId: 11111111-1111-4111-8111-111111111111
      softwareVersionId: 22222222-2222-4222-8222-222222222222
      inputSlots:
        - descriptor: reads
          type: File
          optional: true
          isBatch: false
          expectedFileName: reads.fastq
    - type: NoAction
      id: finish
      name: 汇总结果
  nodeRelations: []
`;
const capabilities = {
  principal: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: getAuthState().email,
    role: "super_admin",
  },
  capabilities: [
    "workspace.provider.view",
    "workspace.provider.manage",
    "workspace.consumer.access",
    "workspace.personal.access",
  ],
  contexts: [],
  activeContextId: "personal",
  devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
};
const queueId = "33333333-3333-4333-8333-333333333333";
window.fetch = async (input, init) => {
  if (init?.method && init.method !== "GET")
    throw new Error("Visual fixtures cannot perform business mutations");
  const path = new URL(String(input), location.origin).pathname;
  let body: unknown;
  if (path.endsWith("/me/capabilities")) body = capabilities;
  else if (path.endsWith("/workflows/drafts/demo"))
    body = { id: "demo", name: "序列分析演示", yaml, placementConfig: {} };
  else if (path.endsWith("/queues/visible"))
    body = {
      queues: [
        {
          queueId,
          name: "CPU 标准队列",
          queueName: "cpu",
          agentId: "demo-agent",
          schedulerType: "slurm",
          qos: null,
          clusterName: "示例集群",
        },
      ],
    };
  else if (path.endsWith("/agents")) body = { agents: [] };
  else if (path.endsWith("/preferences/global")) body = { spec: null };
  else if (path.endsWith("/cp/dashboard"))
    body = {
      kpis: {
        jobsCompleted: 24,
        jobsFailed: 1,
        bytesTransferred: 2048,
        queueDepthPeak: 4,
        agentsHealthy: 6,
        agentsSick: 1,
        agentsOffline: 1,
        topUsers: [],
        topApps: [],
      },
    };
  else if (path.endsWith("/sandbox/account-mapping-review-queue"))
    body = { success: true, data: [] };
  else if (path.endsWith("/cp/software/overview")) body = { agents: [] };
  else if (path.endsWith("/me/active-organization"))
    body = { activeOrganizationId: null, organizations: [] };
  else if (path.endsWith("/usecases")) body = { packages: [] };
  else throw new Error(`Unexpected fixture query: ${path}`);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
function PreferencesDemo() {
  const [area, setArea] = useState("cp");
  return (
    <div className="space-y-5">
      <nav className="flex gap-4 border-b border-border pb-3">
        {[
          ["cp", "算力中心"],
          ["personal", "个人中心"],
          ["appearance", "外观与界面"],
        ].map(([value, label]) => (
          <button key={value} type="button" onClick={() => setArea(value ?? "cp")}>
            {label}
          </button>
        ))}
      </nav>
      {area === "cp" ? (
        <CpDashboard />
      ) : area === "personal" ? (
        <FunctionMaps ids={["D05"]} />
      ) : (
        <MapPreferencesPanel />
      )}
    </div>
  );
}
const root = createRootRoute({
  component: () => (
    <ThemeProvider>
      <main className="mx-auto w-full max-w-7xl p-4 md:p-8">
        {params.get("fixture") === "maps" ? <PreferencesDemo /> : <NewWorkflowPage />}
      </main>
    </ThemeProvider>
  ),
});
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: [location.pathname + location.search] }),
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
