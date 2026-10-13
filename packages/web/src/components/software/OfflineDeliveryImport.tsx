import {
  OFFLINE_DELIVERY_MAX_BYTES,
  type OfflineDelivery,
  type OfflineDeliveryReport,
  OfflineDeliverySchema,
} from "@kuintessence/shared/browser";
import { useEffect, useId, useRef, useState } from "react";
import { requestSoftwareJson, softwareWriteHeaders } from "../../lib/software-client";
import { uploadSpackMaterial } from "../../lib/spack-materials-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function OfflineDeliveryImport({
  isCurrent,
  canWriteRepository,
}: {
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
}) {
  const id = useId();
  const [plan, setPlan] = useState<OfflineDelivery | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<OfflineDeliveryReport | null>(null);
  const [history, setHistory] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const allowed = !!plan && canWriteRepository(plan.repository) && isCurrent();
  async function select(file?: File) {
    setPlan(null);
    setReport(null);
    setHistory(null);
    setError("");
    if (!file) return;
    try {
      if (file.size > OFFLINE_DELIVERY_MAX_BYTES)
        throw new Error("交付清单超过 2 MiB；请先通过 kq-bundles 导出兼容交付目录。");
      const parsed = OfflineDeliverySchema.parse(JSON.parse(await file.text()));
      if (isCurrent()) setPlan(parsed);
    } catch {
      if (isCurrent())
        setError(
          "不支持的交付清单。Forge OCI 原包需先由 kq-bundles 导出 offline-delivery v1；不能直接作为可安装材料导入。",
        );
    }
  }
  async function run(action: "preflight" | "import" | "history") {
    if (!plan || !allowed || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    const check = () => {
      controller.signal.throwIfAborted();
      if (!isCurrent() || !canWriteRepository(plan.repository)) throw new Error("管理会话已变化");
    };
    try {
      check();
      if (action === "preflight" && files.length) {
        const selected = new Map(
          files.map((file) => [
            file.webkitRelativePath
              ? file.webkitRelativePath.split("/").slice(1).join("/")
              : file.name,
            file,
          ]),
        );
        for (const entry of plan.files)
          if (selected.get(entry.path)?.size !== entry.blob.size)
            throw new Error(`缺失文件或大小不匹配：${entry.path}`);
        for (const entry of plan.files) {
          check();
          const file = selected.get(entry.path);
          if (!file) throw new Error("缺失文件");
          await uploadSpackMaterial(plan.repository, entry.blob, file, controller.signal);
        }
      }
      check();
      const result = await requestSoftwareJson<OfflineDeliveryReport>(
        `/offline-deliveries/${action}`,
        {
          method: "POST",
          headers: softwareWriteHeaders(),
          body: JSON.stringify(plan),
          signal: controller.signal,
        },
      );
      check();
      if (action === "history") setHistory(result);
      else setReport(result);
    } catch (failure) {
      if (isCurrent() && !controller.signal.aborted)
        setError(toUserFacingError(failure, "导入失败；可查询持久化收据后重试。"));
    } finally {
      if (isCurrent()) setBusy(false);
      active.current = null;
    }
  }
  return (
    <details className="space-y-3 rounded border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        离线交付导入 / 启动 seed 收据
      </summary>
      <p className="text-xs">
        选择交付清单和目录，上传文件并预检，再执行或重试。导入、绑定、激活分别记录；安装与作业需另行验收。
      </p>
      <label htmlFor={`${id}-plan`} className="block text-xs">
        交付清单 JSON
      </label>
      <Input
        id={`${id}-plan`}
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={(event) => void select(event.target.files?.[0])}
      />
      <label htmlFor={`${id}-files`} className="block text-xs">
        交付目录（大文件直接上传）
      </label>
      <Input
        id={`${id}-files`}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        disabled={busy}
        onChange={(event) => {
          setFiles(Array.from(event.target.files ?? []));
          setReport(null);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={!allowed || busy} onClick={() => void run("preflight")}>
          上传并预检
        </Button>
        <Button
          disabled={
            !allowed ||
            busy ||
            !report ||
            report.items.some((item) => !["planned", "existing"].includes(item.status))
          }
          onClick={() => void run("import")}
        >
          执行 / 重试清单
        </Button>
        <Button variant="outline" disabled={!allowed || busy} onClick={() => void run("history")}>
          查询历史收据
        </Button>
      </div>
      {busy && <p role="status">处理中…</p>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <div>
          <p>
            {report.status} · {report.digest}
          </p>
          <ul>
            {report.items.map((item) => (
              <li key={item.id}>
                {item.id} · {item.kind} · {item.status} {item.code}
                <details>
                  <summary>收据</summary>
                  <pre className="overflow-auto text-xs">
                    {JSON.stringify(item.receipt, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {history !== null && (
        <pre className="max-h-96 overflow-auto text-xs">{JSON.stringify(history, null, 2)}</pre>
      )}
    </details>
  );
}
