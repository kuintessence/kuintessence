import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudPane } from "../src/components/files/CloudPane";
import { JobResourceMap } from "../src/components/jobs/JobResourceMap";
import { SubmitJobDialog } from "../src/components/jobs/SubmitJobDialog";
import { Button } from "../src/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../src/components/ui/dialog";
import { ResourceSelect } from "../src/components/ui/resource-picker";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../src/components/ui/sheet";
import { setLang } from "../src/lib/i18n";
import type { UsecasePackage } from "../src/lib/software-client";
import "./function-maps.css";
const params = new URLSearchParams(window.location.search);
setLang(params.get("language") === "en" ? "en" : "zh");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const filename = `${"sample-".repeat(20)}.bam`;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const pkg: UsecasePackage = {
  id: "example-usecase",
  name: "序列分析",
  version: "1.0",
  description: "分析输入序列",
  createdAt: "2026-01-01",
  spec: {
    softwareRef: { source: "official-upstream", name: "samtools", version: "1.23" },
    inputs: [
      {
        descriptor: "threads",
        type: "Integer",
        required: true,
        default: 4,
        minimum: 1,
        maximum: 16,
      },
      { descriptor: "alignment", type: "File", required: true },
    ],
    usecase: {
      commandFile: "samtools",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "threads",
          refMaterials: [{ kind: "ArgRef", descriptor: "threads", sort: 0 }],
        },
        {
          kind: "File",
          descriptor: "alignment",
          refMaterials: [{ kind: "FileInputRef", descriptor: "alignment" }],
        },
      ],
    },
    software: { kind: "Spack", name: "samtools", version: "1.23", argumentList: [] },
    arguments: [{ descriptor: "threads", valueFormat: "-@ {}" }],
    environments: [],
    filesomeInputs: [{ descriptor: "alignment", fileKind: { kind: "Normal", name: "sample.bam" } }],
    filesomeOutputs: [],
  },
};
client.setQueryData(["software-usecases", null], [pkg]);
client.setQueryData(["queues-visible", null], []);
client.setQueryData(["files-cloud", null], {
  success: true,
  data: {
    files: [
      {
        id: "file-a",
        path: "datasets/sample.bam",
        size: 1024,
        mtime: "2026-01-01T00:00:00Z",
        canUse: true,
        canDelete: false,
      },
    ],
    total: 1,
  },
});
window.fetch = async () => {
  throw new Error("Local fixture does not connect to services");
};
function Preview() {
  const [open, setOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [value, setValue] = useState("");
  const picker = (
    <ResourceSelect
      label="队列"
      options={[
        { value: "cpu", label: "CPU queue" },
        { value: "gpu", label: "GPU queue" },
      ]}
      value={value}
      onValueChange={setValue}
      expandable
    />
  );
  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4">
      <h1 className="text-2xl font-semibold">作业与文件</h1>
      <div className="flex gap-3">
        <Button onClick={() => setOpen(true)}>打开选择器</Button>
        <Button onClick={() => setSubmitOpen(true)}>提交作业</Button>
      </div>
      <CloudPane
        title="文件"
        emptyMessage="空"
        prefix=""
        entries={[
          {
            id: "file-a",
            userId: "example",
            key: `${filename}/sample.bam`,
            size: 1024,
            contentType: "application/octet-stream",
            createdAt: "2026-01-01",
            modifiedAt: "2026-01-01",
            etag: "example",
          },
          {
            id: "file-b",
            userId: "example",
            key: filename,
            size: 1024,
            contentType: "application/octet-stream",
            createdAt: "2026-01-01",
            modifiedAt: "2026-01-01",
            etag: "example",
          },
        ]}
        selected={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        onPrefixChange={() => {}}
      />
      <JobResourceMap
        job={{
          id: "example-job",
          name: "序列分析",
          status: "running",
          submittedAt: "2026-01-01",
          agentId: "example-agent",
          node: "compute-01",
          resources: { cpus: 4, memoryMb: 2048 },
          softwareRequirements: [{ name: "samtools", version: "1.23" }],
          inputStaging: [{ fileMetadataId: "file-a", stagePath: "inputs/sample.bam" }],
          expectedOutputs: [{ descriptor: "summary", path: "summary.txt", isBatch: false }],
        }}
        placement={{
          generatedAt: "2026-01-01",
          preview: false,
          candidateCount: 1,
          stages: [],
          finalDecision: {
            agentId: "example-agent",
            siteName: "示例算力中心",
            schedulerType: "Slurm",
          },
        }}
      />
      {params.get("overlay") === "dialog" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>选择队列</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div style={{ height: params.has("bottom") ? "420px" : "0" }} />
              {picker}
              <output>{value}</output>
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>选择队列</SheetTitle>
            </SheetHeader>
            <SheetBody>
              <div style={{ height: params.has("bottom") ? "480px" : "0" }} />
              {picker}
              <output>{value}</output>
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
      <SubmitJobDialog open={submitOpen} onOpenChange={setSubmitOpen} />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
const previewRoot = createRoot(root, {
  onUncaughtError: (e) => {
    document.body.dataset.previewError = String(e);
  },
  onRecoverableError: (e) => {
    document.body.dataset.previewError = String(e);
  },
});
previewRoot.render(
  <QueryClientProvider client={client}>
    <Preview />
  </QueryClientProvider>,
);
