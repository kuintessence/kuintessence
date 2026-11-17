import type { InterconnectSnapshot } from "@kuintessence/shared/browser";
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
import { MeteringPage } from "../../src/components/cp/MeteringPage";
import { SoftwarePolicyTable } from "../../src/components/cp/SoftwarePolicyTable";
import { MetadataEditor } from "../../src/components/interconnect/MetadataEditor";
import { AuditLogPanel } from "../../src/components/settings/AuditLogPanel";
import { SoftwareCard } from "../../src/components/software/SoftwareCard";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { RefreshButton } from "../../src/components/ui/refresh-button";
import { Tabs, TabsList, TabsTrigger } from "../../src/components/ui/tabs";
import { setAuth } from "../../src/lib/auth";
import { setLang } from "../../src/lib/i18n";

export const organizationId = "11111111-1111-4111-8111-111111111111";
export const zoneId = "22222222-2222-4222-8222-222222222222";
setAuth({ email: "review@example.test", role: "super_admin" });
localStorage.setItem("kq_active_organization_id", organizationId);
localStorage.setItem("kq.theme", "light");
setLang(new URL(location.href).searchParams.get("lang") === "en" ? "en" : "zh");
const snapshot: InterconnectSnapshot = {
  organizations: [{ id: organizationId, name: "研究算力中心" }],
  centers: [
    {
      id: zoneId,
      orgId: organizationId,
      updatedAt: "2026-11-17T00:00:00Z",
      metadata: {
        name: "同城可用区",
        country: "中国",
        province: "北京",
        city: "北京",
        longitude: 116,
        latitude: 40,
        status: "unknown",
      },
    },
  ],
  clusters: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"].map(
    (id, i) => ({
      id,
      centerId: zoneId,
      updatedAt: "2026-11-17T00:00:00Z",
      agentIds: [],
      metadata: {
        name: `计算集群 ${i + 1}`,
        status: "unknown",
        computeTypes: ["CPU"],
        cpuCores: null,
        storageBytes: null,
        storageTypes: [],
        applications: [],
      },
      software: [],
      agents: [],
      jobs24h: { succeeded: 0, failed: 0 },
    }),
  ),
  links: [],
  agents: [],
  defaultView: null,
  generatedAt: "2026-11-17T00:00:00Z",
  canManage: true,
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [saved, setSaved] = useState<unknown>(null);
  const scenario = new URL(location.href).searchParams.get("scenario") ?? "dashboard";
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <main style={{ marginLeft: window.innerWidth >= 768 ? 240 : 0 }} className="min-w-0 p-4">
          {scenario === "dashboard" && <CpDashboard />}
          {scenario === "software" && <SoftwarePolicyTable canManage />}
          {scenario === "metering" && <MeteringPage showWebhooks={false} />}
          {scenario === "audit" && <AuditLogPanel />}
          {scenario === "template" && (
            <div className="grid max-w-2xl auto-rows-max content-start gap-4">
              <div className="kq-fill-row">
                <Tabs defaultValue="managed">
                  <TabsList>
                    <TabsTrigger value="managed">已纳管目标</TabsTrigger>
                    <TabsTrigger value="inventory">调度器观测</TabsTrigger>
                  </TabsList>
                </Tabs>
                <RefreshButton />
              </div>
              <SoftwareCard
                view={{
                  template: {
                    id: "template",
                    name: "固体电子结构",
                    description:
                      "对硅晶体进行自洽和非自洽计算，构造局域 Wannier 函数并绘制插值能带。",
                    createdAt: "2026-11-14T06:59:00Z",
                    version: "20261114.1",
                    tags: [],
                    yamlContent: "",
                  },
                  nodeCount: 7,
                  edgeCount: 6,
                  nodeTypes: ["Script", "SoftwareUsecaseComputing"],
                  usecaseRefs: [],
                  softwareRefs: [],
                  isValidWorkflow: true,
                }}
              />
            </div>
          )}
          {scenario === "network" && (
            <>
              <MetadataEditor
                target={{ kind: "links" }}
                snapshot={snapshot}
                onClose={() => undefined}
                onSave={async (body) => {
                  setSaved(body);
                }}
                onDelete={async () => undefined}
              />
              <pre className="whitespace-pre-wrap break-all" data-testid="saved-link">
                {JSON.stringify(saved)}
              </pre>
            </>
          )}
        </main>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory(),
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <RouterProvider router={router} />,
);
