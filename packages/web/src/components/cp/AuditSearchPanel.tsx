import { ChevronDown, ChevronRight, Filter, Search } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditEntry } from "../../lib/cp-client";
import { useCpSearchAudit } from "../../lib/use-cp-audit";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function localToIso(local: string): string | null {
  if (!local) return null;
  // datetime-local strings have no timezone — treat them as the user's local
  // time and normalize to ISO so the backend Zod schema accepts the string.
  const t = Date.parse(local);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  // datetime-local needs YYYY-MM-DDTHH:mm
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { from: fmt(yesterday), to: fmt(now) };
}

const PAGE_SIZE = 50;
const SENSITIVE_FIELD =
  /secret|token|password|credential|private.?key|api.?key|access.?key|authorization|bearer|passphrase|pem/i;
const INTERNAL_DIAGNOSTIC_FIELD =
  /^(?:error|errors|errorMessage|message|stack|stackTrace|stderr|stdout|statusText|diagnosticMessage|exception|traceback)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldAsString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function auditSummary(row: AuditEntry, t: (key: string, opts?: Record<string, unknown>) => string) {
  const diff = isRecord(row.diff) ? row.diff : null;
  const after = diff && isRecord(diff.after) ? diff.after : null;
  const before = diff && isRecord(diff.before) ? diff.before : null;
  const source = after ?? before;
  if (!source) return "";

  const fields = [
    { key: "reason", value: fieldAsString(source, "reason") },
    { key: "fingerprint", value: fieldAsString(source, "fingerprint") },
    { key: "decision", value: fieldAsString(source, "decision") },
    { key: "revokedAt", value: fieldAsString(source, "revokedAt") },
    { key: "expiresAt", value: fieldAsString(source, "expiresAt") },
  ];

  const entries = fields.flatMap(({ key, value }) => {
    if (!value) return [];
    return [t(`cp.audit.summary.${key}`, { value })];
  });

  return entries.join(" · ");
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_FIELD.test(key)
        ? "[redacted]"
        : INTERNAL_DIAGNOSTIC_FIELD.test(key)
          ? "[internal details hidden]"
          : sanitizeAuditValue(nested),
    ]),
  );
}

function auditDiffText(row: AuditEntry): string {
  const diff = isRecord(row.diff) ? row.diff : null;
  return JSON.stringify(sanitizeAuditValue(diff ?? {}), null, 2);
}

function actionCategory(
  action: string,
): "agent" | "security" | "software" | "job" | "workflow" | "other" {
  if (action.includes("cert") || action.includes("ssh") || action.includes("auth")) {
    return "security";
  }
  if (action.startsWith("agent_") || action.startsWith("agent.")) return "agent";
  if (action.startsWith("software.")) return "software";
  if (action.startsWith("job.")) return "job";
  if (action.startsWith("workflow.")) return "workflow";
  return "other";
}

function categoryVariant(
  category: ReturnType<typeof actionCategory>,
): "brand" | "cancelled" | "default" | "failed" | "outline" | "running" {
  if (category === "security") return "failed";
  if (category === "agent") return "running";
  if (category === "software") return "brand";
  if (category === "job") return "default";
  if (category === "workflow") return "cancelled";
  return "outline";
}

export function AuditSearchPanel() {
  const { t } = useTranslation();
  const initial = defaultRange();
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [text, setText] = useState<string>("");
  const [validation, setValidation] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const m = useCpSearchAudit();

  const runSearch = (textOverride?: string) => {
    const fromIso = localToIso(from);
    const toIso = localToIso(to);
    if (!fromIso) {
      setValidation(t("cp.audit.fromInvalid"));
      return;
    }
    if (!toIso) {
      setValidation(t("cp.audit.toInvalid"));
      return;
    }
    if (Date.parse(fromIso) > Date.parse(toIso)) {
      setValidation(t("cp.audit.fromAfterTo"));
      return;
    }
    setValidation(null);
    const searchText = textOverride ?? text;
    m.mutate({
      from: fromIso,
      to: toIso,
      text: searchText || undefined,
      limit: PAGE_SIZE,
      offset: 0,
    });
  };

  const handleSubmit = () => runSearch();

  const applyQuickFilter = (value: string) => {
    setText(value);
    runSearch(value);
  };

  const hasSearchError = Boolean(m.error);
  const items: AuditEntry[] = hasSearchError ? [] : (m.data?.items ?? []);
  const total = hasSearchError ? 0 : (m.data?.total ?? 0);

  return (
    <div className="space-y-4" data-testid="cp-audit-panel">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.audit.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.audit.subtitle")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="cp-audit-from" className="text-xs font-medium">
            {t("cp.audit.fromLabel")}
          </label>
          <Input
            id="cp-audit-from"
            data-testid="cp-audit-from"
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cp-audit-to" className="text-xs font-medium">
            {t("cp.audit.toLabel")}
          </label>
          <Input
            id="cp-audit-to"
            data-testid="cp-audit-to"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="cp-audit-text" className="text-xs font-medium">
            {t("cp.audit.textLabel")}
          </label>
          <Input
            id="cp-audit-text"
            data-testid="cp-audit-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Button onClick={handleSubmit} data-testid="cp-audit-search-submit" disabled={m.isPending}>
          <Search />
          {t("cp.audit.search")}
        </Button>
        {validation ? (
          <span
            className="min-w-0 break-words text-xs text-[var(--status-failed)]"
            data-testid="cp-audit-validation"
          >
            {validation}
          </span>
        ) : null}
        {m.error ? (
          <span
            className="min-w-0 break-words text-xs text-[var(--status-failed)]"
            data-testid="cp-audit-error"
          >
            {toUserFacingError(m.error, t("cp.audit.loadFailed"))}
          </span>
        ) : null}
        {m.data && !hasSearchError ? (
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="cp-audit-total"
          >
            {t("cp.audit.totalCount", { total })}
          </span>
        ) : null}
      </div>

      {m.data && !hasSearchError && items.length === 0 ? (
        <div
          className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="cp-audit-empty"
        >
          {t("cp.audit.noResults")}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div
          className="overflow-x-auto overscroll-x-contain rounded-md border border-border"
          data-testid="cp-audit-table-scroll"
        >
          <table className="min-w-[72rem] w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.createdAt")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.actor")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.action")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.target")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.summary")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.audit.col.details")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row, idx) => {
                const id = String(row.id ?? idx);
                const action = String(row.action ?? "");
                const target = String(row.target ?? "");
                const summary = auditSummary(row, t);
                const expanded = expandedId === id;
                const category = actionCategory(action);
                return (
                  <Fragment key={id}>
                    <tr
                      data-testid={`cp-audit-row-${id}`}
                      className="border-t border-border last:border-b-0"
                    >
                      <td className="px-3 py-2 font-mono text-xs tabular-nums">
                        {String(row.createdAt ?? "")}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{String(row.actor ?? "")}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={categoryVariant(category)}>
                            {t(`cp.audit.category.${category}`)}
                          </Badge>
                          <code className="text-xs">{action}</code>
                          {action ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title={t("cp.audit.quickFilterAction")}
                              aria-label={t("cp.audit.quickFilterAction")}
                              onClick={() => applyQuickFilter(action)}
                              data-testid={`cp-audit-filter-action-${id}`}
                            >
                              <Filter className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="text-xs">{target}</code>
                          {target ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title={t("cp.audit.quickFilterTarget")}
                              aria-label={t("cp.audit.quickFilterTarget")}
                              onClick={() => applyQuickFilter(target)}
                              data-testid={`cp-audit-filter-target-${id}`}
                            >
                              <Filter className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                      <td className="max-w-[28rem] px-3 py-2 text-xs text-muted-foreground">
                        {summary || "-"}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          onClick={() => setExpandedId((current) => (current === id ? null : id))}
                          data-testid={`cp-audit-details-toggle-${id}`}
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          {expanded ? t("cp.audit.hideDetails") : t("cp.audit.showDetails")}
                        </Button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-t border-border bg-muted/20">
                        <td colSpan={6} className="px-3 py-3">
                          <div className="space-y-2" data-testid={`cp-audit-details-${id}`}>
                            <div className="text-xs font-medium text-muted-foreground">
                              {t("cp.audit.detailsTitle")}
                            </div>
                            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-5">
                              {auditDiffText(row)}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
