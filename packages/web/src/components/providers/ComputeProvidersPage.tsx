import {
  type ComputeProvider,
  type ComputeProviderDirectory,
  ComputeProviderInputSchema,
  ProviderProfileSchema,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { useMediaQuery } from "../../lib/use-media-query";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import { PageHeader, PageShell } from "../ui/page";
import { PaginationControls } from "../ui/pagination-controls";

const fields = ["description", "contactName", "email", "phone", "address", "website"] as const;
type Mode = "provider" | "operator";
export function ComputeProvidersPage({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  const orgId = useActiveOrganizationId();
  const access = usePlatformCapability(
    mode === "provider" ? "workspace.provider.view" : "workspace.platform.view",
  );
  if (!access.ready) return null;
  if (access.error)
    return (
      <div role="alert">
        {toUserFacingError(access.error, t("providers.loadFailed"))}
        <Button onClick={access.retry}>{t("providers.retry")}</Button>
      </div>
    );
  if (!access.allowed) return <p>{t("providers.denied")}</p>;
  return (
    <Directory key={`${mode}:${orgId}:${getAuthState().revision}`} mode={mode} orgId={orgId} />
  );
}
function Directory({ mode, orgId }: { mode: Mode; orgId: string | null }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const endpoint = `/compute-providers/${mode}`;
  const compact = useMediaQuery("(max-width: 767px)");
  const mobileReadOnly = compact && isMobileHighRiskMutationBlocked(`${endpoint}/organizations`);
  const query = useQuery({
    queryKey: ["compute-providers", mode, orgId, getAuthState().revision, search, page],
    queryFn: () =>
      api.get<ComputeProviderDirectory>(
        `${endpoint}/list?search=${encodeURIComponent(search)}&page=${page}`,
      ),
    refetchInterval: 15_000,
  });
  const data = query.data;
  const canEdit = data?.canManage === true && !mobileReadOnly;
  const item = data?.items.find((p) => p.id === selected);
  useEffect(() => {
    if (query.error || !canEdit) setEditing(false);
    if (query.error) setSelected(null);
  }, [query.error, canEdit]);
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["compute-providers"] }),
      client.invalidateQueries({ queryKey: ["me", "active-organization"] }),
      client.invalidateQueries({ queryKey: ["interconnect"] }),
      client.invalidateQueries({ queryKey: ["admin", "authz"] }),
    ]);
  }
  const title = t(mode === "operator" ? "providers.title" : "providers.selfTitle");
  return (
    <PageShell data-testid="compute-providers-page">
      <PageHeader title={title} />
      <div className="kq-fill-row">
        <form
          className="flex min-w-0 basis-full gap-2 sm:basis-80"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(String(new FormData(event.currentTarget).get("search") ?? "").trim());
            setPage(1);
            setSelected(null);
            setEditing(false);
          }}
        >
          <Input
            name="search"
            type="search"
            aria-label={t("providers.search")}
            placeholder={t("providers.search")}
            maxLength={255}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline">
            {t("providers.searchButton")}
          </Button>
        </form>
        <Button variant="outline" onClick={() => query.refetch()}>
          {t("providers.refresh")}
        </Button>
        {mode === "operator" && canEdit && !query.error && (
          <Button
            onClick={() => {
              setSelected(null);
              setEditing(true);
            }}
          >
            {t("providers.create")}
          </Button>
        )}
      </div>
      {data?.canManage && mobileReadOnly && (
        <p className="text-sm text-muted-foreground">{t("providers.desktopEdit")}</p>
      )}
      {query.error ? (
        <div role="alert" className="space-y-2">
          <p>{toUserFacingError(query.error, t("providers.loadFailed"))}</p>
          <Button onClick={() => query.refetch()}>{t("providers.retry")}</Button>
        </div>
      ) : !data ? (
        <p role="status">{t("providers.loading")}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  {["name", "contactName", "centers", "agents", "members", "actions"].map((key) => (
                    <th key={key} className="whitespace-nowrap px-4 py-3 font-medium">
                      {t(`providers.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((provider) => (
                  <tr key={provider.id} className="border-b border-border last:border-0">
                    <td className="min-w-44 px-4 py-3">
                      <button
                        type="button"
                        className="break-words text-left text-brand hover:underline"
                        onClick={() => {
                          setSelected(provider.id);
                          setEditing(false);
                        }}
                      >
                        {provider.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">{provider.profile.contactName || "—"}</td>
                    <td className="px-4 py-3 tabular-nums">{provider.centerCount}</td>
                    <td className="px-4 py-3 tabular-nums">{provider.agentCount}</td>
                    <td className="px-4 py-3 tabular-nums">{provider.memberCount}</td>
                    <td className="px-4 py-3">
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelected(provider.id);
                            setEditing(true);
                          }}
                        >
                          {t("providers.edit")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.items.length && (
              <p className="p-8 text-center text-muted-foreground">{t("providers.empty")}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{t("providers.total", { count: data.total })}</span>
            <PaginationControls
              previous={{
                disabled: page === 1,
                onClick: () => {
                  setPage(page - 1);
                  setSelected(null);
                },
                children: t("providers.previous"),
              }}
              next={{
                disabled: page * 20 >= data.total,
                onClick: () => {
                  setPage(page + 1);
                  setSelected(null);
                },
                children: t("providers.next"),
              }}
            >
              <span>{page}</span>
            </PaginationControls>
          </div>
          {item && !editing && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            >
              <DialogContent aria-describedby={undefined}>
                <DialogHeader>
                  <DialogTitle>{item.name}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 overflow-y-auto p-5">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
                    {fields.map((key) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{t(`providers.${key}`)}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words">
                          {item.profile[key] || "—"}
                        </dd>
                      </div>
                    ))}
                    <dt className="text-muted-foreground">{t("providers.updatedAt")}</dt>
                    <dd>{new Date(item.updatedAt).toLocaleString()}</dd>
                  </dl>
                  {canEdit && (
                    <Button onClick={() => setEditing(true)}>{t("providers.edit")}</Button>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          )}
          {editing && canEdit && (item || (mode === "operator" && !selected)) && (
            <ProviderEditor
              key={item?.id ?? "new"}
              item={item}
              allowDelete={mode === "operator"}
              endpoint={endpoint}
              onClose={() => {
                setEditing(false);
                setSelected(null);
              }}
              onSaved={refresh}
            />
          )}
        </>
      )}
    </PageShell>
  );
}
function ProviderEditor({
  item,
  allowDelete,
  endpoint,
  onClose,
  onSaved,
}: {
  item?: ComputeProvider;
  allowDelete: boolean;
  endpoint: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const defaults = item?.profile ?? ProviderProfileSchema.parse({});
  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.delete(`${endpoint}/organizations/${item?.id}`);
      await onSaved();
      onClose();
    } catch (e) {
      setError(
        e && typeof e === "object" && "status" in e && e.status === 409
          ? t("providers.inUse")
          : toUserFacingError(e, t("providers.deleteFailed")),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        dismissible={!busy}
        dirty
        outsideDismissPolicy="never"
      >
        <DialogHeader>
          <DialogTitle>{t(item ? "providers.edit" : "providers.create")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col overflow-hidden"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const parsed = ComputeProviderInputSchema.safeParse({
              name: form.get("name"),
              profile: Object.fromEntries(
                fields.map((key) => [key, String(form.get(key) ?? "").trim()]),
              ),
            });
            if (!parsed.success) {
              setError(
                t("providers.invalidFields", {
                  fields: [
                    ...new Set(
                      parsed.error.issues.map((issue) =>
                        t(`providers.${String(issue.path.at(-1) ?? "name")}`),
                      ),
                    ),
                  ].join(", "),
                }),
              );
              return;
            }
            setBusy(true);
            setError("");
            try {
              if (item) await api.put(`${endpoint}/organizations/${item.id}`, parsed.data);
              else await api.post(`${endpoint}/organizations`, parsed.data);
              await onSaved();
              onClose();
            } catch (e) {
              setError(toUserFacingError(e, t("providers.saveFailed")));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto p-5">
            <label htmlFor={`${id}-name`} className="grid gap-1.5 text-sm">
              {t("providers.name")}
              <Input
                id={`${id}-name`}
                name="name"
                required
                maxLength={255}
                defaultValue={item?.name ?? ""}
                disabled={busy}
              />
            </label>
            {fields.map((key) => (
              <label key={key} htmlFor={`${id}-${key}`} className="grid gap-1.5 text-sm">
                {t(`providers.${key}`)}
                {key === "description" ? (
                  <Textarea
                    id={`${id}-${key}`}
                    name={key}
                    rows={3}
                    maxLength={2000}
                    defaultValue={defaults[key]}
                    disabled={busy}
                    className="w-full"
                  />
                ) : (
                  <Input
                    id={`${id}-${key}`}
                    name={key}
                    type={key === "email" ? "email" : key === "website" ? "url" : "text"}
                    maxLength={
                      { contactName: 120, email: 254, phone: 80, address: 500, website: 2048 }[key]
                    }
                    defaultValue={defaults[key]}
                    disabled={busy}
                  />
                )}
              </label>
            ))}
            {confirmDelete && (
              <p role="status" className="text-sm text-status-failed">
                {t("providers.deleteWarning", { name: item?.name })}
              </p>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-status-failed">
                {error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 border-t border-border px-5 py-4">
            {item && allowDelete && (
              <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
                {t(confirmDelete ? "providers.confirmDelete" : "providers.delete")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="ml-auto"
              disabled={busy}
              onClick={onClose}
            >
              {t("providers.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(busy ? "providers.saving" : "providers.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
