import type { PlatformCapability } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AttentionOverviewCard } from "../src/components/dashboard/AttentionOverviewCard";
import catalog from "../src/components/function-maps/catalog.json";
import { FunctionMapView } from "../src/components/function-maps/FunctionMapView";
import type { FunctionMap } from "../src/components/function-maps/model";
import { Button } from "../src/components/ui/button";
import { NativeSelect } from "../src/components/ui/native-select";
import { PageHeader, PageShell } from "../src/components/ui/page";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import {
  getWorkspaceIdentity,
  isWorkspaceNavItemActive,
} from "../src/components/workspace-navigation";
import { setLang } from "../src/lib/i18n";
import { useMediaQuery } from "../src/lib/use-media-query";
import "./function-maps.css";

const params = new URLSearchParams(window.location.search);
const demoRole = "super_admin";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(["me", "active-organization"], {
  activeOrganizationId: null,
  organizations: [
    { orgId: "demo-provider", name: "示例算力中心 / Example Compute Center", role: "admin" },
  ],
});
const capabilities = new Set<PlatformCapability>([
  "workspace.provider.view",
  "workspace.provider.manage",
  "workspace.platform.view",
  "workspace.platform.operate",
  "workspace.platform.manage",
]);
const identities = [
  getWorkspaceIdentity("provider-operations"),
  getWorkspaceIdentity("platform-operations"),
];
function WorkspacePreview() {
  const [domain, setDomain] = useState(
    params.get("domain") === "provider" ? "provider" : "platform",
  );
  const [language, setLanguage] = useState(params.get("language") ?? "zh");
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const mobile = useMediaQuery("(max-width: 767px)");
  const [expanded, setExpanded] = useState(!mobile);
  document.documentElement.classList.toggle("dark", dark);
  const model = catalog.find((map) => map.id === "G10") as FunctionMap;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <WorkspaceSidebar
        expanded={expanded}
        identity={getWorkspaceIdentity(
          domain === "provider" ? "provider-operations" : "platform-operations",
        )}
        identities={identities}
        role={demoRole}
        local={false}
        capabilities={null}
        serverCapabilities={capabilities}
        collapseOnNavigate={mobile}
        isNavItemActive={(item) =>
          isWorkspaceNavItemActive(
            item,
            domain === "provider" ? "/cp/profile" : "/operations",
            domain === "provider" ? "" : "overview",
          )
        }
        onNavigate={() => setExpanded(false)}
        onSelectDomain={(value) => setDomain(value)}
        onToggle={() => setExpanded(!expanded)}
      />
      <main className={expanded ? "p-4 md:pl-72 xl:pl-80" : "p-4 md:pl-20"}>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <Button id="workspace-navigation-toggle" onClick={() => setExpanded(!expanded)}>
            菜单 / Menu
          </Button>
          <span>本地模拟 / Local demo</span>
          <NativeSelect
            aria-label="Domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          >
            <option value="platform">平台管理</option>
            <option value="provider">算力中心</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              setLang(event.target.value === "zh" ? "zh" : "en");
            }}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Theme"
            value={dark ? "dark" : "light"}
            onChange={(event) => setDark(event.target.value === "dark")}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </NativeSelect>
        </div>
        <PageShell>
          <PageHeader
            title={
              domain === "provider"
                ? language === "zh"
                  ? "运营资料"
                  : "Provider profile"
                : language === "zh"
                  ? "运营总览"
                  : "Operations overview"
            }
          />
          {domain === "platform" ? (
            <AttentionOverviewCard
              compact
              title={language === "zh" ? "审批待办" : "Approvals"}
              description=""
              icon={ClipboardCheck}
              items={[
                {
                  key: "software",
                  label: language === "zh" ? "软件访问申请" : "Software access",
                  count: 0,
                  href: "#software",
                },
                {
                  key: "storage",
                  label: language === "zh" ? "云存储配额申请" : "Storage quota",
                  count: 1,
                  href: "#storage",
                },
                {
                  key: "accounts",
                  label: language === "zh" ? "隔离运行账号映射" : "Execution accounts",
                  count: 0,
                  href: "#accounts",
                },
              ]}
              emptyLabel=""
              partialFailureLabel=""
              tone="pending"
              testId="demo-approvals"
            />
          ) : (
            <FunctionMapView model={model} language={language} onOpen={() => {}} />
          )}
        </PageShell>
      </main>
    </div>
  );
}
setLang(params.get("language") === "en" ? "en" : "zh");
const route = createRootRoute({ component: WorkspacePreview });
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
