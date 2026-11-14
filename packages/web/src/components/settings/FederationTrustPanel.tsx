import {
  type FederationSiteDetails,
  FederationSiteDetailsSchema,
  FederationSiteViewSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import {
  FederationRefreshNotice,
  FederationSectionTitle,
  useFederationAuthRevision,
} from "../federation/FederationLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  FederationCertificateForm,
  FederationKeyForm,
  FederationSiteForm,
} from "./FederationTrustForms";

const path = "/admin/federation/sites";
const pageSize = 20;
const queryKey = ["federation", "sites"] as const;
type Change = { path: string; body: unknown; method?: "put"; selectId?: string };
type Confirmation = {
  change: Change;
  action: "suspend" | "resume" | "revokeSite" | "revokeKey" | "revokeCertificate";
  target: string;
};

export function FederationTrustPanel() {
  const authRevision = useFederationAuthRevision();
  return <TrustPanel key={authRevision ?? "anonymous"} />;
}
function TrustPanel() {
  const authRevision = useFederationAuthRevision();
  const { t } = useTranslation();
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked(path);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<"new-site" | "site" | "key" | "certificate" | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const list = useQuery({
    queryKey: [...queryKey, "list", page, authRevision],
    queryFn: async () => {
      const result = await api.get<{ data: unknown }>(
        `${path}?limit=${pageSize}&offset=${page * pageSize}`,
      );
      return z.array(FederationSiteViewSchema).parse(result.data);
    },
  });
  const detail = useQuery({
    queryKey: [...queryKey, "detail", selected, authRevision],
    enabled: !!selected,
    queryFn: async () => {
      const result = await api.get<{ data: unknown }>(`${path}/${selected}`);
      return FederationSiteDetailsSchema.parse(result.data);
    },
  });
  const change = useMutation({
    mutationFn: async (input: Change) =>
      input.method === "put" ? api.put(input.path, input.body) : api.post(input.path, input.body),
    onSuccess: async (_result, input) => {
      if (input.selectId) setSelected(input.selectId);
      setEditor(null);
      setConfirmation(null);
      await client.invalidateQueries({ queryKey });
      toast.success(t("federation.saved"));
    },
  });
  useEffect(() => {
    if (mobileReadOnly) {
      setEditor(null);
      setConfirmation(null);
    }
  }, [mobileReadOnly]);
  const save = (input: Change) => {
    if (mobileReadOnly || change.isPending || list.isError || (selected && detail.isError)) return;
    change.reset();
    change.mutate(input);
  };
  const open = (kind: typeof editor) => {
    change.reset();
    setEditor(kind);
  };
  const select = (id: string | null) => {
    setSelected(id);
    setEditor(null);
    setConfirmation(null);
    change.reset();
  };
  const confirm = (input: Confirmation) => {
    change.reset();
    setConfirmation(input);
  };
  const readOnly = mobileReadOnly || change.isPending;
  const site = detail.data;
  const canChange =
    !readOnly && !!site && site.state !== "revoked" && !detail.isError && !list.isError;
  const failure = change.isError ? (
    <p role="alert" className="text-sm text-status-failed">
      {toUserFacingError(change.error, t("federation.saveFailed"))}
    </p>
  ) : null;
  return (
    <Card data-testid="federation-trust-panel" aria-label={t("federation.title")}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        {selected ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={change.isPending || editor !== null}
            onClick={() => select(null)}
          >
            <ArrowLeft className="h-4 w-4" />
            {t("federation.back")}
          </Button>
        ) : (
          <FederationSectionTitle title={t("federation.title")} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={
              change.isPending ||
              (editor !== null && !list.isError && !detail.isError) ||
              list.isFetching ||
              detail.isFetching
            }
            onClick={() => void client.invalidateQueries({ queryKey })}
          >
            <RefreshCw className="h-4 w-4" />
            {t("federation.refresh")}
          </Button>
          <Button
            size="sm"
            disabled={readOnly || editor !== null || list.isError || list.isPending}
            onClick={() => {
              select(null);
              open("new-site");
            }}
          >
            <Plus className="h-4 w-4" />
            {t("federation.addSite")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <FederationRefreshNotice query={list} onRetry={() => void list.refetch()} />
        <FederationRefreshNotice query={detail} onRetry={() => void detail.refetch()} />
        {editor && (federationReadFailed(list) || federationReadFailed(detail)) ? (
          <Button variant="ghost" disabled={change.isPending} onClick={() => open(null)}>
            {t("federation.cancel")}
          </Button>
        ) : null}
        {mobileReadOnly && (
          <p className="text-sm text-muted-foreground">{t("federation.desktopOnly")}</p>
        )}
        {list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("federation.loading")}
          </p>
        ) : federationReadFailed(list) || !list.data ? (
          <p role="alert" className="text-sm text-status-failed">
            {toUserFacingError(list.error, t("federation.loadFailed"))}
          </p>
        ) : editor === "new-site" ? (
          <div className="max-w-3xl space-y-4">
            <FederationSiteForm
              busy={change.isPending}
              blocked={list.isError || detail.isError}
              onCancel={() => open(null)}
              onSubmit={(input) => save({ path, body: input, selectId: input.id })}
            />
            {failure}
          </div>
        ) : selected ? (
          <div className="space-y-5">
            {detail.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("federation.loading")}
              </p>
            ) : federationReadFailed(detail) || !detail.data ? (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(detail.error, t("federation.loadFailed"))}
              </p>
            ) : site ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-lg font-semibold">{site.name}</h3>
                      <Badge variant="outline">{t(`federation.states.${site.state}`)}</Badge>
                    </div>
                    <p className="break-all text-sm text-muted-foreground">{site.endpoint}</p>
                    <code className="block break-all text-xs text-muted-foreground">{site.id}</code>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canChange || editor !== null}
                      onClick={() => open("site")}
                    >
                      {t("federation.edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canChange || editor !== null}
                      onClick={() =>
                        confirm({
                          action: site.state === "active" ? "suspend" : "resume",
                          target: site.name,
                          change: {
                            path: `${path}/${site.id}/state`,
                            body: { state: site.state === "active" ? "suspended" : "active" },
                          },
                        })
                      }
                    >
                      {t(site.state === "active" ? "federation.suspend" : "federation.resume")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canChange || editor !== null}
                      onClick={() =>
                        confirm({
                          action: "revokeSite",
                          target: site.name,
                          change: {
                            path: `${path}/${site.id}/state`,
                            body: { state: "revoked" },
                          },
                        })
                      }
                    >
                      {t("federation.revokeSite")}
                    </Button>
                  </div>
                </div>
                {editor ? (
                  <div className="max-w-3xl border-t border-border pt-5">
                    {editor === "site" ? (
                      <FederationSiteForm
                        key={site.id}
                        site={site}
                        busy={change.isPending}
                        blocked={list.isError || detail.isError}
                        onCancel={() => open(null)}
                        onSubmit={({ name, endpoint }) =>
                          save({
                            path: `${path}/${site.id}`,
                            method: "put",
                            body: { name, endpoint },
                          })
                        }
                      />
                    ) : editor === "key" ? (
                      <FederationKeyForm
                        busy={change.isPending}
                        blocked={list.isError || detail.isError}
                        onCancel={() => open(null)}
                        onSubmit={(body) => save({ path: `${path}/${site.id}/keys`, body })}
                      />
                    ) : (
                      <FederationCertificateForm
                        busy={change.isPending}
                        blocked={list.isError || detail.isError}
                        onCancel={() => open(null)}
                        onSubmit={(body) => save({ path: `${path}/${site.id}/certificates`, body })}
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <TrustMaterialList
                      title={t("federation.keys")}
                      addLabel={t("federation.addKey")}
                      empty={t("federation.noKeys")}
                      disabled={!canChange}
                      onAdd={() => open("key")}
                    >
                      {site.keys.map((key) => (
                        <MaterialRow
                          key={key.keyId}
                          label={key.keyId}
                          material={key}
                          pem={key.publicKeyPem}
                          disabled={!canChange || !!key.revokedAt}
                          onRevoke={() =>
                            confirm({
                              action: "revokeKey",
                              target: key.keyId,
                              change: {
                                path: `${path}/${site.id}/revoke`,
                                body: { keyId: key.keyId },
                              },
                            })
                          }
                        >
                          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            {key.allowedKinds.map((kind) => (
                              <li key={kind}>{t(`federation.kinds.${kind}`)}</li>
                            ))}
                          </ul>
                        </MaterialRow>
                      ))}
                    </TrustMaterialList>
                    <TrustMaterialList
                      title={t("federation.certificates")}
                      addLabel={t("federation.addCertificate")}
                      empty={t("federation.noCertificates")}
                      disabled={!canChange}
                      onAdd={() => open("certificate")}
                    >
                      {site.certificates.map((cert) => (
                        <MaterialRow
                          key={cert.fingerprint}
                          label={cert.fingerprint}
                          material={cert}
                          pem={cert.certificatePem}
                          disabled={!canChange || !!cert.revokedAt}
                          onRevoke={() =>
                            confirm({
                              action: "revokeCertificate",
                              target: cert.fingerprint,
                              change: {
                                path: `${path}/${site.id}/revoke`,
                                body: { fingerprint: cert.fingerprint },
                              },
                            })
                          }
                        />
                      ))}
                    </TrustMaterialList>
                  </>
                )}
                {!confirmation && failure}
              </>
            ) : null}
          </div>
        ) : (
          <>
            {list.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("federation.noSites")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {list.data.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="flex min-h-16 w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                      onClick={() => select(row.id)}
                    >
                      <span className="min-w-0 space-y-1">
                        <span className="block break-words text-sm font-medium">{row.name}</span>
                        <span className="block break-all text-sm text-muted-foreground">
                          {row.endpoint}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline">{t(`federation.states.${row.state}`)}</Badge>
                        <ChevronRight className="h-4 w-4" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(page > 0 || list.data.length === pageSize) && (
              <nav
                aria-label={t("federation.pagination")}
                className="flex items-center justify-end gap-3"
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || list.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t("federation.previous")}
                </Button>
                <span className="text-sm tabular-nums">{page + 1}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={list.data.length < pageSize || list.isFetching}
                  onClick={() => setPage(page + 1)}
                >
                  {t("federation.next")}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
            )}
          </>
        )}
        <Dialog
          open={!!confirmation && !federationReadFailed(list) && !federationReadFailed(detail)}
          onOpenChange={(value) => {
            if (!value && !change.isPending) setConfirmation(null);
          }}
        >
          <DialogContent dismissible={!change.isPending}>
            <DialogHeader>
              <DialogTitle>
                {confirmation ? t(`federation.${confirmation.action}`) : ""}
              </DialogTitle>
              <DialogDescription>
                {confirmation ? t(`federation.impact.${confirmation.action}`) : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <p className="break-all text-sm">{confirmation?.target}</p>
              {failure}
            </DialogBody>
            <DialogFooter className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={change.isPending}
                onClick={() => setConfirmation(null)}
              >
                {t("federation.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={readOnly}
                onClick={() => {
                  if (confirmation) save(confirmation.change);
                }}
              >
                {t(change.isPending ? "federation.saving" : "federation.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function TrustMaterialList({
  title,
  addLabel,
  empty,
  disabled,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  empty: string;
  disabled: boolean;
  onAdd: () => void;
  children: ReactNode[];
}) {
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{title}</h4>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onAdd}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
      {children.length ? (
        <ul className="divide-y divide-border">{children}</ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}
function MaterialRow({
  label,
  material,
  pem,
  disabled,
  onRevoke,
  children,
}: {
  label: string;
  material: Pick<FederationSiteDetails["keys"][number], "validFrom" | "validUntil" | "revokedAt">;
  pem: string;
  disabled: boolean;
  onRevoke: () => void;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const status = material.revokedAt
    ? "revoked"
    : Date.parse(material.validUntil) <= Date.now()
      ? "expired"
      : Date.parse(material.validFrom) > Date.now()
        ? "scheduled"
        : "active";
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all text-sm">{label}</code>
            <Badge variant="outline">{t(`federation.states.${status}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {new Date(material.validFrom).toLocaleString(i18n.language)} →{" "}
            {new Date(material.validUntil).toLocaleString(i18n.language)}
          </p>
          {children}
        </div>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onRevoke}>
          {t("federation.revoke")}
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("federation.viewPem")}
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{pem}</pre>
      </details>
    </li>
  );
}
