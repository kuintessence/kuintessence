import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TransfersTray } from "../../src/components/files/TransfersTray";
import { JobsToolbar } from "../../src/components/jobs/JobsToolbar";
import type { AccessScopeFilter, StatusFilter } from "../../src/components/jobs/types";
import { Badge } from "../../src/components/ui/badge";
import { Button } from "../../src/components/ui/button";
import { DataTable } from "../../src/components/ui/data-table";
import { DialogFooter } from "../../src/components/ui/dialog";
import { Textarea } from "../../src/components/ui/input";
import { NativeSelect } from "../../src/components/ui/native-select";
import { PageHeader, PageShell } from "../../src/components/ui/page";
import { Tabs, TabsList, TabsTrigger } from "../../src/components/ui/tabs";
import { setLang } from "../../src/lib/i18n";

setLang("zh");

const data = Array.from({ length: 32 }, (_, index) => ({
  name: `演示作业 ${String(index + 1).padStart(2, "0")}`,
  queue: index % 2 === 0 ? "CPU · standard" : "GPU · accelerated",
  status: index % 2 === 0 ? "运行中" : "已完成",
}));
const columns: ColumnDef<(typeof data)[number]>[] = [
  { accessorKey: "name", header: "作业名称" },
  { accessorKey: "queue", header: "队列" },
  {
    accessorKey: "status",
    header: "状态",
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
];

function Fixture() {
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [scope, setScope] = useState<AccessScopeFilter>("all");
  const [action, setAction] = useState("");
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <PageShell>
        <PageHeader
          title="作业"
          subtitle="组件验证 · 以下均为演示数据"
          actions={
            <Button
              variant="outline"
              onClick={() => document.documentElement.classList.toggle("dark")}
            >
              切换主题
            </Button>
          }
        />
        <JobsToolbar
          search={filter}
          onSearchChange={setFilter}
          status={status}
          onStatusChange={setStatus}
          scope={scope}
          onScopeChange={setScope}
          onSubmitJob={() => setAction("提交作业")}
          onImportJson={() => setAction("导入 JSON")}
          onCreateFromUsecase={() => setAction("从用例创建")}
        />
        <Tabs defaultValue="overview">
          <TabsList aria-label="演示详情">
            {(
              [
                ["overview", "概览"],
                ["resources", "计算资源"],
                ["inputs", "输入文件"],
                ["logs", "运行日志"],
                ["outputs", "结果与制品"],
                ["history", "历史记录"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <DialogFooter data-testid="demo-footer">
          <Button variant="outline">取消</Button>
          <Button>确认选择</Button>
        </DialogFooter>
        {action ? <p role="status">演示操作：{action}</p> : null}
        <DataTable columns={columns} data={data} globalFilter={filter} pageSize={10} />
        <div className="h-64">
          <TransfersTray transfers={[]} onChanged={() => {}} />
        </div>
        <form className="grid gap-4 border-t pt-5 sm:grid-cols-2">
          <label className="grid gap-2 text-sm">
            执行账号
            <NativeSelect name="account" required defaultValue="">
              <option value="" disabled>
                请选择执行账号
              </option>
              <option value="research">research</option>
            </NativeSelect>
          </label>
          <label className="grid gap-2 text-sm">
            当前集群
            <NativeSelect name="disabled" disabled>
              <option>演示集群</option>
            </NativeSelect>
          </label>
          <label className="grid gap-2 text-sm sm:col-span-2">
            备注
            <Textarea rows={3} placeholder="输入备注" />
          </label>
        </form>
      </PageShell>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
