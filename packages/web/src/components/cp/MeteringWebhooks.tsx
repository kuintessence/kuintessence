import { Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type CreateWebhookInput,
  useCreateWebhook,
  useDeleteWebhook,
  useMeteringWebhooks,
} from "../../lib/use-metering-webhooks";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

const MIN_SECRET_LENGTH = 8;

/**
 * CP metering webhook-subscriber management: list / create / delete external
 * billing endpoints that receive `usage.daily` / `usage.monthly` summaries.
 * Rendered at the bottom of the metering page, independent of usage rows.
 */
export function MeteringWebhooks({ organizationId = null }: { organizationId?: string | null }) {
  const { t } = useTranslation();
  const list = useMeteringWebhooks(organizationId);
  const create = useCreateWebhook();
  const remove = useDeleteWebhook();

  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [daily, setDaily] = useState(false);
  const [monthly, setMonthly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const hasListError = Boolean(list.error);

  function resetForm() {
    setUrl("");
    setSecret("");
    setDaily(false);
    setMonthly(false);
    setEnabled(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (hasListError) return;
    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
      toast.error(t("cp.metering.webhooks.invalidUrl"));
      return;
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      toast.error(t("cp.metering.webhooks.invalidSecret"));
      return;
    }
    const events: string[] = [];
    if (daily) events.push("usage.daily");
    if (monthly) events.push("usage.monthly");
    if (events.length === 0) {
      toast.error(t("cp.metering.webhooks.invalidEvents"));
      return;
    }
    const input: CreateWebhookInput = { url: trimmedUrl, secret, events, enabled };
    create.mutate(input, {
      onSuccess: () => {
        toast.success(t("cp.metering.webhooks.created"));
        resetForm();
      },
      onError: (err: unknown) => {
        toast.error(toUserFacingError(err, t("cp.metering.webhooks.createFailed")));
      },
    });
  }

  function onDelete(id: string) {
    remove.mutate(id, {
      onSuccess: () => {
        toast.success(t("cp.metering.webhooks.deleted"));
      },
      onError: (err: unknown) => {
        toast.error(toUserFacingError(err, t("cp.metering.webhooks.createFailed")));
      },
    });
  }

  const items = list.data ?? [];

  return (
    <Card data-testid="metering-webhooks">
      <CardHeader>
        <CardTitle>{t("cp.metering.webhooks.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("cp.metering.webhooks.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.error ? (
          <div className="text-sm text-status-failed" data-testid="webhooks-error">
            {toUserFacingError(list.error, t("cp.metering.webhooks.loadFailed"))}
          </div>
        ) : list.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("cp.metering.loading")}
          </div>
        ) : items.length === 0 ? (
          <p className="text-[11px] text-muted-foreground" data-testid="webhooks-empty">
            {t("cp.metering.webhooks.empty")}
          </p>
        ) : (
          <div
            className="overflow-x-auto overscroll-x-contain rounded-md border border-border"
            data-testid="webhook-table-scroll"
          >
            <table className="min-w-[52rem] w-full text-sm" data-testid="webhook-table">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("cp.metering.webhooks.col.url")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.metering.webhooks.col.events")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.metering.webhooks.col.enabled")}</th>
                  <th className="px-3 py-2 font-medium text-right">
                    {t("cp.metering.webhooks.col.failures")}
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    {t("cp.metering.webhooks.col.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((w, i) => (
                  <tr
                    key={w.id}
                    data-testid={`webhook-row-${i}`}
                    className="border-t border-border last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{w.url}</td>
                    <td className="px-3 py-2 text-xs">{w.events.join(", ")}</td>
                    <td className="px-3 py-2 text-xs">
                      {w.enabled ? t("cp.metering.webhooks.yes") : t("cp.metering.webhooks.no")}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                      {w.failures}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid={`webhook-delete-${i}`}
                        onClick={() => onDelete(w.id)}
                        disabled={remove.isPending}
                        aria-label={t("cp.metering.webhooks.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="space-y-3" onSubmit={onSubmit}>
          <div className="flex flex-col gap-1">
            <label htmlFor="webhook-url" className="text-xs font-medium">
              {t("cp.metering.webhooks.urlLabel")}
            </label>
            <Input
              id="webhook-url"
              data-testid="webhook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://billing.example/hook"
              disabled={hasListError}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="webhook-secret" className="text-xs font-medium">
              {t("cp.metering.webhooks.secretLabel")}
            </label>
            <Input
              id="webhook-secret"
              data-testid="webhook-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={hasListError}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("cp.metering.webhooks.secretHint")}
            </p>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium">{t("cp.metering.webhooks.eventsLabel")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="webhook-event-daily"
                checked={daily}
                onChange={(e) => setDaily(e.target.checked)}
                disabled={hasListError}
              />
              usage.daily
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="webhook-event-monthly"
                checked={monthly}
                onChange={(e) => setMonthly(e.target.checked)}
                disabled={hasListError}
              />
              usage.monthly
            </label>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="webhook-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={hasListError}
            />
            {t("cp.metering.webhooks.enabledLabel")}
          </label>
          <Button
            type="submit"
            size="sm"
            data-testid="webhook-add"
            disabled={hasListError || create.isPending}
          >
            {create.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {create.isPending ? t("cp.metering.webhooks.adding") : t("cp.metering.webhooks.add")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
