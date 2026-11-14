import {
  MediaExportDetailSchema,
  MediaExportOperationSchema,
  MediaImportOperationSchema,
  MediaImportReceiptViewSchema,
  MediaPackageDetailSchema,
  MediaRecordedReceiptSchema,
} from "@kuintessence/shared/federation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { Button } from "../ui/button";
import { FederationRefreshNotice } from "./FederationLayout";
import {
  type MediaDeliveryAction,
  MediaDeliveryForm,
  mediaActionCapability,
} from "./MediaDeliveryForm";
import { MediaPagination, type MediaScope } from "./MediaLogisticsShared";

export function MediaDeliveryDetail({
  scope,
  direction,
  packageId,
  busy,
  capabilities,
  onSaved,
}: {
  scope: MediaScope;
  direction: "exports" | "packages";
  packageId: string;
  busy: boolean;
  capabilities: readonly string[];
  onSaved: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(0);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [action, setAction] = useState<MediaDeliveryAction | null>(null);
  const key = ["federation", "media", scope.organizationId, scope.authRevision];
  const query = useQuery({
    queryKey: [...key, direction, packageId, page],
    queryFn: async () => {
      const raw = (
        await api.get<{ data: unknown }>(
          `/federation/media/${direction}/${packageId}?authorizationOffset=${page * 100}`,
          scope,
        )
      ).data;
      const value =
        direction === "exports"
          ? MediaExportDetailSchema.parse(raw)
          : MediaPackageDetailSchema.parse(raw);
      if (
        value.packageId !== packageId ||
        (direction === "exports" ? value.manifest.senderSiteId : value.manifest.recipientSiteId) !==
          scope.localSiteId
      )
        throw new Error("Media detail scope mismatch");
      return value;
    },
    refetchOnWindowFocus: false,
  });
  const current = !federationReadFailed(query) ? query.data : undefined;
  const blocked = busy || query.isFetching || query.isError;
  const actionAuthorization =
    current && "authorizations" in current && action && "authorizationId" in action
      ? current.authorizations.find((item) => item.authorizationId === action.authorizationId)
      : undefined;
  const actionUnavailable =
    !current ||
    (action && "authorizationId" in action && action.authorizationId && !actionAuthorization) ||
    (action?.kind !== "retryReceipt" &&
      (!!current.revokedAt || !!actionAuthorization?.revokedAt)) ||
    (action?.kind === "run" &&
      (("expiresAt" in current && Date.parse(current.expiresAt) <= Date.now()) ||
        (actionAuthorization && Date.parse(actionAuthorization.expiresAt) <= Date.now())));
  const form = action ? (
    <MediaDeliveryForm
      key={JSON.stringify(action)}
      scope={scope}
      action={action}
      busy={blocked || !!actionUnavailable || !capabilities.includes(mediaActionCapability(action))}
      onCancel={() => setAction(null)}
      onSaved={async () => {
        setAction(null);
        await onSaved();
      }}
    />
  ) : null;
  if (federationReadFailed(query))
    return (
      <div className="space-y-5">
        <p role="alert">{t("federation.loadFailed")}</p>
        {form}
      </div>
    );
  if (!current)
    return (
      <div className="space-y-5">
        <p role="status">{t("federation.loading")}</p>
        {form}
      </div>
    );
  const incoming = "authorizations" in current ? current : null;
  const selected = incoming?.authorizations.find(
    (item) => item.authorizationId === authorizationId,
  );
  const active =
    !current.revokedAt && (!("expiresAt" in current) || Date.parse(current.expiresAt) > Date.now());
  const button = (next: MediaDeliveryAction, disabled = false) =>
    capabilities.includes(mediaActionCapability(next)) ? (
      <Button
        variant="outline"
        disabled={blocked || !!action || disabled}
        onClick={() => setAction(next)}
      >
        {t(
          `federation.delivery.actions.${next.kind === "revoke" && next.authorizationId ? "revokeApproval" : next.kind}`,
        )}
      </Button>
    ) : null;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { senderSiteId: current.manifest.senderSiteId, signedManifest: current.signedManifest },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `media-${packageId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-5">
      <FederationRefreshNotice query={query} onRetry={() => void query.refetch()} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-semibold">
            {t(`federation.delivery.kinds.${current.manifest.subject.kind}`)}
          </h3>
          <code className="block break-all text-xs">{packageId}</code>
        </div>
        <span className="rounded-md bg-muted px-3 py-1 text-sm">
          {t(
            `federation.delivery.states.${current.revokedAt ? "revoked" : !active ? "expired" : incoming ? "registered" : "approved"}`,
          )}
        </span>
      </div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {[
          ["sender", current.manifest.senderSiteId],
          ["recipient", current.manifest.recipientSiteId],
          ["files", String(current.manifest.files.length)],
          [
            "bytes",
            current.manifest.files
              .reduce((sum, file) => sum + file.sizeBytes, 0)
              .toLocaleString(i18n.language),
          ],
          ["createdAt", new Date(current.manifest.createdAt).toLocaleString(i18n.language)],
          ...("expiresAt" in current
            ? [["expiresAt", new Date(current.expiresAt).toLocaleString(i18n.language)]]
            : []),
        ].map(([name, value]) => (
          <div key={name} className="min-w-0">
            <dt className="text-muted-foreground">{t(`federation.delivery.${name}`)}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {current.revocationReason ? (
        <p className="whitespace-pre-wrap break-words text-sm">{current.revocationReason}</p>
      ) : null}
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("federation.delivery.manifest")}
        </summary>
        <div className="mt-3 space-y-3">
          <Button variant="outline" disabled={blocked} onClick={download}>
            {t("federation.delivery.downloadManifest")}
          </Button>
          <code className="block break-all text-xs">{current.manifestDigest}</code>
          <ul className="divide-y divide-border">
            {current.manifest.files.map((file) => (
              <li key={file.path} className="space-y-1 py-3 text-sm">
                <p className="break-all font-medium">{file.path}</p>
                <p>
                  {file.sizeBytes.toLocaleString(i18n.language)} B ·{" "}
                  {file.license ?? t("federation.delivery.missingLicense")}
                </p>
                <code className="block break-all text-xs">{file.sha256}</code>
                {file.provenance ? (
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(file.provenance, null, 2)}
                  </pre>
                ) : (
                  <p>{t("federation.delivery.missingProvenance")}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </details>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        {incoming
          ? button({ kind: "approve", packageId, sizeBytes: incoming.sizeBytes }, !active)
          : null}
        {button({ kind: "revoke", packageId, direction }, !!current.revokedAt)}
      </div>
      {form}
      {incoming ? (
        <section className="space-y-3" aria-label={t("federation.delivery.authorizations")}>
          <h4 className="font-medium">{t("federation.delivery.authorizations")}</h4>
          {!incoming.authorizations.length ? (
            <p className="text-sm text-muted-foreground">
              {t("federation.delivery.noAuthorizations")}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border">
              {incoming.authorizations.map((item) => (
                <li key={item.authorizationId}>
                  <button
                    type="button"
                    disabled={!!action}
                    aria-pressed={authorizationId === item.authorizationId}
                    className="flex w-full flex-wrap justify-between gap-2 p-3 text-left text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-ring aria-pressed:bg-muted"
                    onClick={() => setAuthorizationId(item.authorizationId)}
                  >
                    <span className="min-w-0 break-all">
                      {item.agentId}
                      <code className="block text-xs">{item.authorizationId}</code>
                    </span>
                    <span>
                      {t(
                        `federation.delivery.states.${item.revokedAt ? "revoked" : Date.parse(item.expiresAt) <= Date.now() ? "expired" : "approved"}`,
                      )}{" "}
                      · {new Date(item.expiresAt).toLocaleString(i18n.language)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <MediaPagination
            page={page}
            hasMore={incoming.hasMoreAuthorizations}
            busy={blocked || !!action}
            onChange={(next) => {
              setPage(next);
              setAuthorizationId(null);
            }}
          />
          {selected ? (
            <div className="space-y-3 border-t pt-3">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t("federation.delivery.roots")}</dt>
                  <dd className="break-all">{selected.managedRootId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("federation.delivery.maxBytes")}</dt>
                  <dd>{selected.maxBytes.toLocaleString(i18n.language)}</dd>
                </div>
              </dl>
              {button(
                { kind: "revoke", packageId, direction, authorizationId: selected.authorizationId },
                !!selected.revokedAt,
              )}
            </div>
          ) : null}
        </section>
      ) : null}
      {!incoming || selected ? (
        <MediaDeliveryOperation
          key={selected?.authorizationId ?? packageId}
          scope={scope}
          direction={direction}
          packageId={packageId}
          authorizationId={selected?.authorizationId}
          senderSiteId={current.manifest.senderSiteId}
          recipientSiteId={current.manifest.recipientSiteId}
          manifestDigest={current.manifestDigest}
          blocked={blocked || !!action}
          capabilities={capabilities}
          active={
            active &&
            (!selected || (!selected.revokedAt && Date.parse(selected.expiresAt) > Date.now()))
          }
          onAction={setAction}
        />
      ) : null}
    </div>
  );
}
function MediaDeliveryOperation({
  scope,
  direction,
  packageId,
  authorizationId,
  senderSiteId,
  recipientSiteId,
  manifestDigest,
  blocked,
  capabilities,
  active,
  onAction,
}: {
  scope: MediaScope;
  direction: "exports" | "packages";
  packageId: string;
  authorizationId?: string;
  senderSiteId: string;
  recipientSiteId: string;
  manifestDigest: string;
  blocked: boolean;
  capabilities: readonly string[];
  active: boolean;
  onAction: (action: MediaDeliveryAction) => void;
}) {
  const { t, i18n } = useTranslation();
  const [receiptsOpen, setReceiptsOpen] = useState(false),
    [page, setPage] = useState(0);
  const path = `/federation/media/${direction}/${packageId}${authorizationId ? `/import-authorizations/${authorizationId}` : ""}`;
  const key = [
    "federation",
    "media",
    scope.organizationId,
    scope.authRevision,
    direction,
    packageId,
    authorizationId,
  ];
  const operation = useQuery({
    queryKey: [...key, "operation"],
    queryFn: async () => {
      const raw = (await api.get<{ data: unknown }>(`${path}/operation`, scope)).data;
      if (raw === null) return null;
      if (direction === "exports") {
        const row = MediaExportOperationSchema.parse(raw);
        if (row.packageId !== packageId || row.localSiteId !== scope.localSiteId)
          throw new Error("Media operation mismatch");
        return row;
      }
      const row = MediaImportOperationSchema.parse(raw);
      if (row.authorizationId !== authorizationId) throw new Error("Media operation mismatch");
      return row;
    },
    refetchOnWindowFocus: false,
  });
  const receipts = useQuery({
    queryKey: [...key, "receipts", page],
    enabled: receiptsOpen && !operation.isError && (direction === "exports" || !!operation.data),
    queryFn: async () => {
      if (direction === "exports") {
        const rows = z
          .array(MediaRecordedReceiptSchema)
          .max(20)
          .parse(
            (
              await api.get<{ data: unknown }>(
                `${path}/receipts?limit=20&offset=${page * 20}`,
                scope,
              )
            ).data,
          );
        for (const row of rows) checkReceipt(row.receipt);
        return { kind: "source" as const, rows };
      }
      const row = MediaImportReceiptViewSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/receipt`, scope)).data,
      );
      if (row.receipt) {
        checkReceipt(row.receipt);
        if (row.receipt.generation !== operation.data?.generation)
          throw new Error("Media receipt authorization mismatch");
      }
      return { kind: "target" as const, ...row };
    },
    refetchOnWindowFocus: false,
  });
  function checkReceipt(receipt: z.infer<typeof MediaRecordedReceiptSchema>["receipt"]) {
    if (
      receipt.packageId !== packageId ||
      receipt.senderSiteId !== recipientSiteId ||
      receipt.recipientSiteId !== senderSiteId ||
      receipt.manifestDigest !== manifestDigest
    )
      throw new Error("Media receipt mismatch");
  }
  if (federationReadFailed(operation)) return <p role="alert">{t("federation.loadFailed")}</p>;
  if (operation.isPending || operation.data === undefined)
    return <p role="status">{t("federation.loading")}</p>;
  const row = operation.data;
  const run: MediaDeliveryAction = { kind: "run", direction, packageId, authorizationId };
  return (
    <section className="space-y-3 border-t pt-4" aria-label={t("federation.delivery.operation")}>
      <FederationRefreshNotice query={operation} onRetry={() => void operation.refetch()} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-medium">
          {t("federation.delivery.operation")} ·{" "}
          {t(`federation.delivery.states.${row?.state ?? "notStarted"}`)}
        </h4>
        {capabilities.includes(mediaActionCapability(run)) ? (
          <Button
            variant="outline"
            disabled={
              blocked ||
              operation.isFetching ||
              operation.isError ||
              !active ||
              (!!row && row.state !== "failed")
            }
            onClick={() => onAction(run)}
          >
            {t("federation.delivery.actions.run")}
          </Button>
        ) : null}
      </div>
      {row ? (
        <time className="block text-sm" dateTime={row.updatedAt}>
          {new Date(row.updatedAt).toLocaleString(i18n.language)}
        </time>
      ) : null}
      {row && "sha256" in row && row.sha256 ? (
        <code className="block break-all text-xs">
          {row.sha256} · {row.sizeBytes?.toLocaleString(i18n.language)} B
        </code>
      ) : null}
      {row?.state === "verified" ? (
        <p className="text-sm text-muted-foreground">{t("federation.delivery.privateVerified")}</p>
      ) : null}
      {direction === "exports" || row ? (
        <details onToggle={(event) => setReceiptsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-medium">
            {t("federation.delivery.receipts")}
          </summary>
          {receiptsOpen ? (
            <div className="mt-3 space-y-3">
              <FederationRefreshNotice query={receipts} onRetry={() => void receipts.refetch()} />
              {federationReadFailed(receipts) ? (
                <p role="alert">{t("federation.loadFailed")}</p>
              ) : receipts.isPending ? (
                <p role="status">{t("federation.loading")}</p>
              ) : receipts.data?.kind === "source" ? (
                <>
                  {!receipts.data.rows.length ? (
                    <p className="text-sm text-muted-foreground">
                      {t("federation.delivery.noReceipts")}
                    </p>
                  ) : (
                    receipts.data.rows.map((item) => (
                      <pre
                        key={item.receipt.receiptId}
                        className="whitespace-pre-wrap break-all text-xs"
                      >
                        {JSON.stringify(item, null, 2)}
                      </pre>
                    ))
                  )}
                  <MediaPagination
                    page={page}
                    hasMore={receipts.data.rows.length === 20}
                    busy={receipts.isFetching}
                    onChange={setPage}
                  />
                </>
              ) : receipts.data?.kind === "target" ? (
                <>
                  <p className="text-sm">
                    {t(`federation.delivery.states.${receipts.data.state}`)}
                  </p>
                  {receipts.data.state === "pending" &&
                  authorizationId &&
                  capabilities.includes("media.import") ? (
                    <Button
                      variant="outline"
                      disabled={
                        blocked || operation.isError || receipts.isFetching || receipts.isError
                      }
                      onClick={() => onAction({ kind: "retryReceipt", packageId, authorizationId })}
                    >
                      {t("federation.delivery.actions.retryReceipt")}
                    </Button>
                  ) : null}
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(receipts.data, null, 2)}
                  </pre>
                </>
              ) : null}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
