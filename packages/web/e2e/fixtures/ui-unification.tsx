import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { Button } from "../../src/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../src/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../src/components/ui/dialog";
import { PageHeader, PageShell } from "../../src/components/ui/page";
import { ResourceSelect } from "../../src/components/ui/resource-picker";
import { WorkflowEditorShell } from "../../src/components/workflow/WorkflowEditorShell";
import { setAuth } from "../../src/lib/auth";
import { setLang } from "../../src/lib/i18n";
import { rememberSelection } from "../../src/lib/recent-selections";

localStorage.setItem(
  "kq.theme",
  document.documentElement.classList.contains("dark") ? "dark" : "light",
);
const en = new URL(location.href).searchParams.get("lang") === "en";
setLang(en ? "en" : "zh");
setAuth({ email: "demo@example.test" });
localStorage.setItem("kq_active_organization_id", "demo");
const label = (zh: string, english: string) => (en ? english : zh);
const queues = [
  {
    value: "cpu",
    label: label("通用计算队列", "General compute"),
    description: "Slurm · cpu-standard · 64 cores",
    keywords: ["east", "华东"],
  },
  {
    value: "gpu",
    label: label("GPU 加速队列", "GPU accelerated"),
    description: "Slurm · gpu-a100 · 8 GPUs",
    keywords: ["west", "华西"],
  },
  {
    value: "offline",
    label: label("维护队列", "Maintenance queue"),
    description: "PBS · scheduled maintenance",
    disabled: true,
    disabledReason: label("维护中，暂不可选", "Unavailable during maintenance"),
  },
  ...Array.from({ length: 12 }, (_, index) => ({
    value: `batch-${index + 1}`,
    label: label(`批处理队列 ${index + 1}`, `Batch queue ${index + 1}`),
    description: `Slurm · batch-${index + 1} · CPU`,
  })),
];
rememberSelection(
  { userId: "demo@example.test", organizationId: "demo", resourceType: "demo-queue" },
  "gpu",
);
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
});
client.setQueryData(["software-usecases"], []);
client.setQueryData(["sandbox-runtime-profiles"], []);
client.setQueryData(["sandbox-scripts"], []);
const yaml = `name: demo
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: prepare
      name: ${label("准备输入", "Prepare inputs")}
    - type: NoAction
      id: compute
      name: ${label("执行计算", "Run computation")}
  nodeRelations:
    - fromId: prepare
      toId: compute
      slotRelations: []
`;
function Fixture() {
  const [queue, setQueue] = useState("cpu");
  const [modalQueue, setModalQueue] = useState("cpu");
  const [formOpen, setFormOpen] = useState(false);
  const [graph, setGraph] = useState(yaml);
  const queueLabel = label("计算队列", "Compute queue");
  const form = (
    <div className="grid min-w-0 gap-6 sm:grid-cols-2">
      <div className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold">
          {label("方案 A · 搜索下拉", "A · Search dropdown")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {label(
            "支持最近选择、次要信息与展开选择。",
            "Recent choices, details and expanded selection.",
          )}
        </p>
        <ResourceSelect
          label={queueLabel}
          options={queues}
          value={queue}
          onValueChange={setQueue}
          recent
          resourceType="demo-queue"
          clearable
          expandable
        />
        <output data-testid="selected-a" className="block text-sm text-muted-foreground">
          {label("已保存：", "Saved: ")}
          {queue}
        </output>
      </div>
      <div className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold">
          {label("方案 B · 遮罩选择", "B · Modal picker")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {label("搜索、排序、分页，确认后回填。", "Search, sort and paginate. Confirm to apply.")}
        </p>
        <ResourceSelect
          label={label("弹层队列", "Modal queue")}
          options={queues}
          value={modalQueue}
          onValueChange={setModalQueue}
          presentation="dialog"
        />
        <output data-testid="selected-b" className="block text-sm text-muted-foreground">
          {label("已保存：", "Saved: ")}
          {modalQueue}
        </output>
      </div>
    </div>
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <main className="mx-auto min-w-0 max-w-7xl space-y-6 p-4 sm:p-6">
          <PageShell>
            <PageHeader
              title={label("统一组件与资源选择", "Unified components & resource selection")}
              subtitle={label(
                "实际组件预览 · 全部为离线演示数据",
                "Actual components · offline demonstration data",
              )}
              actions={
                <Button variant="outline" onClick={() => setFormOpen(true)}>
                  {label("在表单中选择", "Choose in a form")}
                </Button>
              }
            />
            {form}
            <Card className="border bg-muted rounded-xl shadow-lg">
              <CardHeader>
                <CardTitle>{label("资源说明", "Resource details")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">
                  {label(
                    "这是通过其他组件组合的内部区块，保持透明布局，只通过间距与文字层级区分。",
                    "This composed section remains transparent, separated by spacing and typography.",
                  )}
                </p>
              </CardContent>
            </Card>
          </PageShell>
          <PageShell>
            <PageHeader
              title={label("工作流编辑器", "Workflow editor")}
              subtitle={label(
                "保留拖拽连线、属性编辑与图 / YAML 同步。",
                "Drag connections, edit properties and synchronize graph / YAML.",
              )}
            />
            <WorkflowEditorShell value={graph} onChange={setGraph} />
          </PageShell>
          <Dialog open={formOpen} onOpenChange={setFormOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>{label("作业资源配置", "Job resources")}</DialogTitle>
              </DialogHeader>
              <DialogBody>{form}</DialogBody>
            </DialogContent>
          </Dialog>
        </main>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
