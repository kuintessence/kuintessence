import {
  FederationCurrentCapabilitiesSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { FederationMaterialOptionSchema } from "@kuintessence/shared/federation/outbound-views";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { AgreementFact } from "./AgreementTerms";
import {
  type AssetAction,
  AssetMappingSchema,
  AssetMaterialSchema,
  mappingReference,
  materialDigest,
} from "./asset-material";
import { FederationAssetImport } from "./FederationAssetImport";
import {
  FederationEmpty,
  FederationPanelHeader,
  FederationRefreshNotice,
} from "./FederationLayout";

type MaterialOption = z.infer<typeof FederationMaterialOptionSchema>;
const path = "/federation/assets";

export function FederationAssetsPanel({
  scope,
  switching,
}: {
  scope: ApiOrganizationScope;
  switching: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [tab, setTab] = useState<"material" | "mapping">("material");
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AssetAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<MaterialOption | null>(null);
  const [saved, setSaved] = useState(false);
  const refreshFocus = useRef<HTMLButtonElement>(null);
  const reviewFocus = useRef<HTMLButtonElement>(null);
  const readOnly = useMobileMutationBlocked(path);
  const key = ["federation", "assets", scope.organizationId, scope.authRevision];
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
    refetchOnWindowFocus: false,
  });
  const grants =
    !federationReadFailed(capabilities) && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = grants.includes("asset.read");
  const canWrite = grants.includes("asset.map") && !readOnly && !capabilities.isError;
  const allowed = useRef(false);
  allowed.current = canWrite && !switching && !capabilities.isFetching;
  useEffect(() => {
    if (!canWrite) {
      setCreating(false);
      setDraft(null);
      setConfirming(false);
    }
    if (!canRead) setSelected(null);
  }, [canWrite, canRead]);
  const materials = useQuery({
    queryKey: [...key, "materials", page],
    enabled: canRead && tab === "material" && !creating && !draft && !selected,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const value = z
        .object({ data: z.array(FederationMaterialOptionSchema), hasMore: z.boolean() })
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${path}/materials?limit=20&offset=${page * 20}`,
              scope,
            )
          ).data,
        );
      if (value.data.some((row) => row.localOrgId !== scope.organizationId))
        throw new Error("Material scope mismatch");
      return value;
    },
  });
  const mappings = useQuery({
    queryKey: [...key, "mappings", page],
    enabled: canRead && tab === "mapping" && !creating && !draft,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const rows = z
        .array(AssetMappingSchema)
        .parse(
          (await api.get<{ data: unknown }>(`${path}/mappings?limit=20&offset=${page * 20}`, scope))
            .data,
        );
      if (rows.some((row) => row.localOrgId !== scope.organizationId))
        throw new Error("Mapping scope mismatch");
      return rows;
    },
  });
  const detail = useQuery({
    queryKey: [...key, "content", selected?.originSiteId, selected?.digest],
    enabled: canRead && !!selected,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async () => {
      if (!selected) throw new Error("No material selected");
      const raw = (
        await api.get<{ data: unknown }>(
          `${path}/materials/${selected.originSiteId}/${selected.digest}`,
          scope,
        )
      ).data;
      if ((await materialDigest(raw)) !== selected.digest)
        throw new Error("Material digest mismatch");
      const content = AssetMaterialSchema.parse(raw);
      if (content.kind !== selected.kind) throw new Error("Material kind mismatch");
      return content;
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: AssetAction) => {
      if (!allowed.current) throw new Error("Asset management unavailable");
      if (action.kind === "revoke") {
        z.object({ success: z.literal(true) }).parse(
          await api.post(`${path}/mappings/${action.mapping.id}/revoke`, {}, scope),
        );
      } else if (action.kind === "mapping") {
        const row = AssetMappingSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${path}/mappings`,
              { reference: action.reference, localRevisionId: action.localRevisionId },
              scope,
            )
          ).data,
        );
        if (
          row.localOrgId !== scope.organizationId ||
          row.revokedAt ||
          federationCanonicalJson(mappingReference(row)) !==
            federationCanonicalJson(action.reference) ||
          (row.softwareRevisionId ?? row.dataVersionId) !== action.localRevisionId
        )
          throw new Error("Mapping response mismatch");
      } else {
        const row = z
          .object({
            digest: FederationMaterialOptionSchema.shape.digest,
            kind: FederationMaterialOptionSchema.shape.kind,
          })
          .parse(
            (
              await api.post<{ data: unknown }>(
                `${path}/materials`,
                { originSiteId: action.originSiteId, content: action.content },
                scope,
              )
            ).data,
          );
        if (row.digest !== action.digest || row.kind !== action.content.kind)
          throw new Error("Material response mismatch");
      }
    },
    onSuccess: async () => {
      setConfirming(false);
      setDraft(null);
      setCreating(false);
      if (allowed.current) {
        setSaved(true);
        setPage(0);
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: ["federation", "task-options", scope.organizationId, scope.authRevision],
        }),
      ]);
    },
  });
  const uncertain =
    mutation.isError &&
    !(mutation.error instanceof ApiError && [400, 403, 409].includes(mutation.error.status));
  const busy =
    switching ||
    capabilities.isFetching ||
    mutation.isPending ||
    capabilities.isError ||
    (tab === "material" ? materials.isError : mappings.isError);
  allowed.current = allowed.current && !busy;
  const review = (action: AssetAction) => {
    if (!allowed.current) return;
    mutation.reset();
    setSaved(false);
    setDraft(action);
    setConfirming(true);
  };
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (federationReadFailed(capabilities) || !canRead)
    return (
      <div className="space-y-3">
        <p role={capabilities.isError ? "alert" : "status"}>
          {t(capabilities.isError ? "federation.loadFailed" : "federation.assets.noPermission")}
        </p>
        <Button
          variant="outline"
          disabled={capabilities.isFetching}
          onClick={() => void capabilities.refetch()}
        >
          {t("federation.refresh")}
        </Button>
      </div>
    );
  const inventory = tab === "material" ? materials : mappings;
  const failed = federationReadFailed(inventory);
  const fetching = tab === "material" ? materials.isFetching : mappings.isFetching;
  const pending = inventory.isPending || !inventory.data;
  const hasMore = tab === "material" ? materials.data?.hasMore : mappings.data?.length === 20;
  const title = draft
    ? t(`federation.assets.${draft.kind === "revoke" ? "revoke" : `add.${draft.kind}`}`)
    : "";
  return (
    <div className="min-w-0 space-y-5">
      <FederationPanelHeader title={t("federation.assets.title")}>
        <Button
          ref={refreshFocus}
          variant="outline"
          disabled={switching || capabilities.isFetching || mutation.isPending || fetching}
          onClick={() => {
            void capabilities.refetch();
            void client.invalidateQueries({ queryKey: key });
          }}
        >
          {t("federation.refresh")}
        </Button>
        {canWrite && !creating && !draft && !selected ? (
          <Button
            disabled={busy}
            onClick={() => {
              setSaved(false);
              mutation.reset();
              setCreating(true);
            }}
          >
            {t(`federation.assets.add.${tab}`)}
          </Button>
        ) : null}
      </FederationPanelHeader>
      <FederationRefreshNotice query={capabilities} onRetry={() => void capabilities.refetch()} />
      <FederationRefreshNotice query={inventory} onRetry={() => void inventory.refetch()} />
      <FederationRefreshNotice query={detail} onRetry={() => void detail.refetch()} />
      {saved ? (
        <p role="status" className="text-sm">
          {t("federation.assets.saved")}
        </p>
      ) : null}
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t("federation.agreements.desktopOnly")}</p>
      ) : null}
      {failed ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : creating && !draft ? (
        <FederationAssetImport
          kind={tab}
          disabled={busy || !canWrite}
          onCancel={() => setCreating(false)}
          onReview={review}
        />
      ) : draft ? (
        <div className="space-y-4">
          <AssetReview action={draft} />
          {mutation.isError && !confirming ? (
            <p role="alert" className="text-sm text-status-failed">
              {t(uncertain ? "federation.assets.unknown" : "federation.assets.failed")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              ref={reviewFocus}
              disabled={busy || !canWrite}
              onClick={() => setConfirming(true)}
            >
              {t(uncertain ? "federation.assets.retry" : "federation.assets.review")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || uncertain}
              onClick={() => {
                setDraft(null);
                mutation.reset();
              }}
            >
              {t("federation.cancel")}
            </Button>
          </div>
        </div>
      ) : selected ? (
        <div className="space-y-4">
          <Button variant="ghost" onClick={() => setSelected(null)}>
            {t("federation.assets.back")}
          </Button>
          {federationReadFailed(detail) ? (
            <p role="alert">{t("federation.assets.detailFailed")}</p>
          ) : detail.isPending || !detail.data ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <AgreementFact label={t("federation.assets.origin")}>
                  {selected.originSiteId}
                </AgreementFact>
                <AgreementFact label={t("federation.assets.digest")}>
                  {selected.digest}
                </AgreementFact>
              </dl>
              <MaterialSummary content={detail.data} />
              <Button
                variant="outline"
                disabled={detail.isFetching}
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(detail.data, null, 2)], { type: "application/json" }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${selected.kind}-${selected.digest.slice(7)}.json`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                {t("federation.assets.download")}
              </Button>
              <details className="text-sm">
                <summary className="cursor-pointer">{t("federation.assets.content")}</summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(detail.data, null, 2)}
                </pre>
              </details>
            </>
          )}
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as typeof tab);
              setPage(0);
              setSaved(false);
            }}
          >
            <TabsList className="federation-subnav" aria-label={t("federation.assets.title")}>
              <TabsTrigger value="material">{t("federation.assets.materials")}</TabsTrigger>
              <TabsTrigger value="mapping">{t("federation.assets.mappings")}</TabsTrigger>
            </TabsList>
          </Tabs>
          {failed ? (
            <p role="alert">{t("federation.loadFailed")}</p>
          ) : pending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <ul className="federation-list divide-y divide-border">
              {tab === "material"
                ? materials.data?.data.map((row) => (
                    <li key={`${row.originSiteId}:${row.digest}`}>
                      <button
                        type="button"
                        className="federation-list-row w-full space-y-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setSelected(row)}
                      >
                        <span className="block font-medium text-sm">
                          {t(`federation.assets.kinds.${row.kind}`)}
                        </span>
                        <span className="block break-all font-mono text-xs">
                          {row.digest.slice(0, 19)}…
                        </span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {t("federation.assets.origin")}: {row.originSiteId.slice(0, 8)} ·{" "}
                          {new Date(row.createdAt).toLocaleString(i18n.language)}
                        </span>
                      </button>
                    </li>
                  ))
                : mappings.data?.map((row) => (
                    <li key={row.id} className="space-y-3 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="min-w-0 break-all text-sm font-medium">
                          {t(`federation.tasks.kinds.${row.kind}`)} · {row.originId} ·{" "}
                          {row.originRevision}
                        </p>
                        <span className="text-xs">
                          {t(
                            row.revokedAt
                              ? "federation.assets.revoked"
                              : "federation.assets.active",
                          )}
                        </span>
                      </div>
                      <details className="text-sm">
                        <summary className="cursor-pointer">
                          {t("federation.assets.mappingDetails")}
                        </summary>
                        <div className="mt-3">
                          <AssetReview action={{ kind: "revoke", mapping: row }} />
                        </div>
                      </details>
                      {canWrite && !row.revokedAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => review({ kind: "revoke", mapping: row })}
                        >
                          {t("federation.assets.revoke")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
            </ul>
          )}
          {!failed &&
          !pending &&
          !(tab === "material" ? materials.data?.data.length : mappings.data?.length) ? (
            <FederationEmpty>{t(`federation.assets.empty.${tab}`)}</FederationEmpty>
          ) : null}
          {page > 0 || hasMore ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || fetching || page === 0}
                onClick={() => setPage(page - 1)}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || fetching || failed || !hasMore}
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={confirming && !!draft && canWrite}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirming(false);
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (reviewFocus.current ?? refreshFocus.current)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t(
                draft?.kind === "revoke"
                  ? "federation.assets.revokeEffect"
                  : "federation.assets.importEffect",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {draft ? <AssetReview action={draft} /> : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t(uncertain ? "federation.assets.unknown" : "federation.assets.failed")}
                {mutation.error instanceof ApiError ? ` (${mutation.error.code})` : ""}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={busy || !draft || !canWrite}
              onClick={() => draft && mutation.mutate(draft)}
            >
              {t(
                mutation.isPending
                  ? "federation.saving"
                  : uncertain
                    ? "federation.assets.retry"
                    : "federation.confirm",
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssetReview({ action }: { action: AssetAction }) {
  const { t } = useTranslation();
  const ref =
    action.kind === "material"
      ? null
      : action.kind === "mapping"
        ? action.reference
        : mappingReference(action.mapping);
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <AgreementFact label={t("federation.assets.origin")}>
          {action.kind === "material" ? action.originSiteId : ref?.originSiteId}
        </AgreementFact>
        <AgreementFact label={t("federation.assets.digest")}>
          {action.kind === "material" ? action.digest : ref?.digest}
        </AgreementFact>
        {ref ? (
          <>
            <AgreementFact label={t("federation.assets.kind")}>
              {t(`federation.tasks.kinds.${ref.kind}`)}
            </AgreementFact>
            <AgreementFact label={t("federation.assets.id")}>{ref.id}</AgreementFact>
            <AgreementFact label={t("federation.assets.revision")}>{ref.revision}</AgreementFact>
            <AgreementFact label={t("federation.assets.localRevision")}>
              {action.kind === "mapping"
                ? action.localRevisionId
                : action.kind === "revoke"
                  ? (action.mapping.softwareRevisionId ?? action.mapping.dataVersionId)
                  : null}
            </AgreementFact>
          </>
        ) : null}
      </dl>
      {action.kind === "material" ? <MaterialSummary content={action.content} /> : null}
      {action.kind === "material" ? (
        <details className="text-sm">
          <summary className="cursor-pointer">{t("federation.assets.content")}</summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(action.content, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function MaterialSummary({ content }: { content: z.infer<typeof AssetMaterialSchema> }) {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-4 text-sm sm:grid-cols-2">
      <AgreementFact label={t("federation.assets.kind")}>
        {t(`federation.assets.kinds.${content.kind}`)}
      </AgreementFact>
      {content.kind === "inputs" ? (
        <>
          <AgreementFact label={t("federation.assets.parameters")}>
            {Object.keys(content.parameters).length}
          </AgreementFact>
          <AgreementFact label={t("federation.assets.datasets")}>
            {content.datasets.length}
          </AgreementFact>
          <AgreementFact label={t("federation.assets.bindings")}>
            {content.bindings.length}
          </AgreementFact>
        </>
      ) : (
        <>
          <AgreementFact label={t("federation.assets.target")}>
            {content.target.platform} / {content.target.architecture}
          </AgreementFact>
          <AgreementFact label={t("federation.assets.software")}>
            {content.software.length}
          </AgreementFact>
          <AgreementFact label={t("federation.assets.nativeLock")}>
            {content.nativeLockDigest}
          </AgreementFact>
        </>
      )}
    </dl>
  );
}
