import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AuditEntry } from "../../lib/dashboard-data";

export interface EventsListProps {
  entries: AuditEntry[];
  forbidden?: boolean;
}

type EventCopy = {
  labelKey: string;
  defaultLabel: string;
  categoryKey: string;
  defaultCategory: string;
  subject: string;
};

function relative(iso: string, now: Date = new Date(), locale?: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const seconds = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  return formatter.format(-days, "day");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function filePath(entry: AuditEntry): string | null {
  return (
    stringField(entry.diff?.after, "path") ??
    stringField(entry.diff?.before, "path") ??
    readableTarget(entry.target)
  );
}

function readableTarget(target: string): string | null {
  if (target.length === 0) return null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(target)) return null;
  return target;
}

function actorLabel(actor: string): string | null {
  if (actor.includes("@")) return actor;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(actor)) return null;
  return actor.length > 0 ? actor : null;
}

function describeEvent(entry: AuditEntry): EventCopy {
  const path = filePath(entry);
  const actor = actorLabel(entry.actor);
  const subject = path ?? actor ?? "平台记录";
  switch (entry.action) {
    case "netdrive.upload-url.mint":
      return {
        labelKey: "dashboard.events.netdriveUploadPrepared",
        defaultLabel: "准备上传文件",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "netdrive.multipart.init":
      return {
        labelKey: "dashboard.events.netdriveMultipartStarted",
        defaultLabel: "开始上传大文件",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "netdrive.multipart.complete":
      return {
        labelKey: "dashboard.events.netdriveMultipartCompleted",
        defaultLabel: "完成大文件上传",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "netdrive.multipart.abort":
      return {
        labelKey: "dashboard.events.netdriveMultipartAborted",
        defaultLabel: "取消大文件上传",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "netdrive.file.commit":
      return {
        labelKey: "dashboard.events.netdriveFileSaved",
        defaultLabel: "保存了云盘文件",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "netdrive.file.delete":
      return {
        labelKey: "dashboard.events.netdriveFileDeleted",
        defaultLabel: "删除了云盘文件",
        categoryKey: "dashboard.events.categoryFiles",
        defaultCategory: "云盘",
        subject,
      };
    case "job.create":
    case "job.submit":
      return {
        labelKey: "dashboard.events.jobSubmitted",
        defaultLabel: "提交了作业",
        categoryKey: "dashboard.events.categoryJobs",
        defaultCategory: "作业",
        subject,
      };
    case "job.cancel":
      return {
        labelKey: "dashboard.events.jobCanceled",
        defaultLabel: "取消了作业",
        categoryKey: "dashboard.events.categoryJobs",
        defaultCategory: "作业",
        subject,
      };
    case "ssh.session_open":
      return {
        labelKey: "dashboard.events.sshOpened",
        defaultLabel: "打开了 SSH 会话",
        categoryKey: "dashboard.events.categoryAccess",
        defaultCategory: "访问",
        subject,
      };
    case "ssh.session_close":
      return {
        labelKey: "dashboard.events.sshClosed",
        defaultLabel: "关闭了 SSH 会话",
        categoryKey: "dashboard.events.categoryAccess",
        defaultCategory: "访问",
        subject,
      };
    case "sso.config.update":
      return {
        labelKey: "dashboard.events.ssoUpdated",
        defaultLabel: "更新了单点登录配置",
        categoryKey: "dashboard.events.categorySecurity",
        defaultCategory: "安全",
        subject,
      };
    default:
      return {
        labelKey: "dashboard.events.platformUpdated",
        defaultLabel: "更新了平台配置",
        categoryKey: "dashboard.events.categoryPlatform",
        defaultCategory: "平台",
        subject,
      };
  }
}

export function EventsList({ entries, forbidden }: EventsListProps) {
  const { t, i18n } = useTranslation();
  if (forbidden) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground"
        data-testid="events-forbidden"
      >
        <Activity className="h-3.5 w-3.5" />
        {t("dashboard.auditForbidden")}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
        data-testid="events-empty"
      >
        {t("dashboard.noRecentEvents")}
      </div>
    );
  }
  return (
    <ul className="space-y-2" data-testid="events-list">
      {entries.slice(0, 10).map((e) => {
        const copy = describeEvent(e);
        return (
          <li
            key={e.id}
            className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
            title={`${t(copy.labelKey, { defaultValue: copy.defaultLabel })}: ${copy.subject}`}
          >
            <span className="text-xs text-muted-foreground tabular-nums" title={e.createdAt}>
              {relative(e.createdAt, new Date(), i18n?.language)}
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">
                  {t(copy.labelKey, { defaultValue: copy.defaultLabel })}
                </span>
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                  {t(copy.categoryKey, { defaultValue: copy.defaultCategory })}
                </span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{copy.subject}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
