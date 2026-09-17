import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, LockKeyhole, RefreshCw, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type DataAccessRequest,
  type DataAssetSummary,
  dataMarketClient,
} from "../../lib/data-market-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { PageHeader, PageShell } from "../ui/page";

export function DataMarketPage() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"catalog" | "private">("catalog");
  const [selected, setSelected] = useState<DataAssetSummary | null>(null);
  const [privateName, setPrivateName] = useState("");
  const [privateFile, setPrivateFile] = useState<File | null>(null);
  const [privateVersion, setPrivateVersion] = useState("v1");
  const [privateKind, setPrivateKind] = useState<"scientific-dataset" | "licensed-material">(
    "scientific-dataset",
  );
  const [privateElements, setPrivateElements] = useState("");
  const [requestingAssetId, setRequestingAssetId] = useState<string | null>(null);
  const catalog = useQuery({
    queryKey: ["data-market", "catalog", query],
    queryFn: () => dataMarketClient.catalog({ query: query || undefined }),
  });
  const assets = useMemo(
    () =>
      (catalog.data?.assets ?? []).filter(
        (asset) => scope === "catalog" || asset.visibility === "private",
      ),
    [catalog.data?.assets, scope],
  );
  const catalogAssetIds = useMemo(
    () => (catalog.data?.assets ?? []).map((asset) => asset.id),
    [catalog.data?.assets],
  );
  const myAccessRequests = useQuery({
    enabled: catalogAssetIds.length > 0,
    queryKey: ["data-market", "access-requests", "mine", catalogAssetIds],
    queryFn: () => dataMarketClient.myAccessRequests(catalogAssetIds),
  });

  async function createPrivate(): Promise<void> {
    if (!privateName.trim() || !privateFile || !privateVersion.trim()) return;
    const elements = privateElements
      .split(/[，,\s]+/)
      .map((element) => element.trim())
      .filter(Boolean);
    if (privateKind === "licensed-material" && elements.length === 0) {
      toast.error(t("dataMarket.elementsRequired"));
      return;
    }
    try {
      const asset = await dataMarketClient.createPrivateAsset({
        name: privateName.trim(),
        kind: privateKind,
        ...(privateKind === "licensed-material"
          ? { accessMode: "entitlement", sensitivity: "restricted", elements }
          : {}),
      });
      await dataMarketClient.uploadAssetFile(asset.id, privateVersion.trim(), privateFile);
      setPrivateName("");
      setPrivateFile(null);
      setPrivateElements("");
      await cache.invalidateQueries({ queryKey: ["data-market", "catalog"] });
      toast.success(t("dataMarket.privateUploaded"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("dataMarket.failed")));
    }
  }

  async function requestAccess(asset: DataAssetSummary, reason?: string): Promise<void> {
    setRequestingAssetId(asset.id);
    try {
      if (asset.visibility === "private" && asset.kind === "licensed-material") {
        await dataMarketClient.requestOwnerEntitlement(asset.id, reason ?? "");
      } else {
        await dataMarketClient.requestAccess(asset.id, null);
      }
      const refreshed = await myAccessRequests.refetch();
      if (refreshed.error) throw refreshed.error;
      toast.success(t("dataMarket.requestCreated"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("dataMarket.failed")));
    } finally {
      setRequestingAssetId(null);
    }
  }

  return (
    <PageShell data-testid="data-market-page">
      <PageHeader
        title={t("dataMarket.title")}
        subtitle={t("dataMarket.subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void Promise.all([catalog.refetch(), myAccessRequests.refetch()])}
          >
            <RefreshCw />
            {t("common.refresh")}
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{t("dataMarket.catalog")}</CardTitle>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={scope === "catalog" ? "default" : "outline"}
                  onClick={() => setScope("catalog")}
                >
                  {t("dataMarket.catalog")}
                </Button>
                <Button
                  size="sm"
                  variant={scope === "private" ? "default" : "outline"}
                  onClick={() => setScope("private")}
                >
                  {t("dataMarket.myPrivate")}
                </Button>
              </div>
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("dataMarket.search")}
            />
          </CardHeader>
          <CardContent className="space-y-2">
            {assets.map((asset) => (
              <button
                type="button"
                key={asset.id}
                data-testid={`data-asset-${asset.id}`}
                className="w-full rounded-lg border border-border p-3 text-left hover:border-brand/60 hover:bg-muted/30"
                onClick={() => setSelected(asset)}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{asset.name}</span>
                  <Badge variant="outline">{asset.visibility}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {asset.description ?? t("dataMarket.noDescription")}
                </p>
              </button>
            ))}
            {!catalog.isLoading && assets.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("dataMarket.empty")}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>{t("dataMarket.createPrivate")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{t("dataMarket.privateRestriction")}</p>
              <Input
                value={privateName}
                onChange={(event) => setPrivateName(event.target.value)}
                placeholder={t("dataMarket.name")}
              />
              <Input
                value={privateVersion}
                onChange={(event) => setPrivateVersion(event.target.value)}
                placeholder={t("dataMarket.version")}
              />
              <label className="grid gap-1 text-sm font-medium">
                {t("dataMarket.privateKind")}
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={privateKind}
                  onChange={(event) =>
                    setPrivateKind(event.target.value as "scientific-dataset" | "licensed-material")
                  }
                >
                  <option value="scientific-dataset">{t("dataMarket.kindScientific")}</option>
                  <option value="licensed-material">{t("dataMarket.kindLicensed")}</option>
                </select>
              </label>
              {privateKind === "licensed-material" ? (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                  <p>{t("dataMarket.licensedRestriction")}</p>
                  <Input
                    value={privateElements}
                    onChange={(event) => setPrivateElements(event.target.value)}
                    placeholder={t("dataMarket.elements")}
                    aria-label={t("dataMarket.elements")}
                  />
                </div>
              ) : null}
              <Input
                type="file"
                aria-label={t("dataMarket.privateFile")}
                onChange={(event) => setPrivateFile(event.target.files?.[0] ?? null)}
              />
              <Button
                disabled={
                  !privateFile ||
                  !privateName.trim() ||
                  (privateKind === "licensed-material" && !privateElements.trim())
                }
                onClick={() => void createPrivate()}
              >
                <Upload />
                {t("dataMarket.privateUpload")}
              </Button>
            </CardContent>
          </Card>
          {selected ? (
            <DataAssetDetail
              key={selected.id}
              asset={selected}
              activeUse={myAccessRequests.data?.activeUseAssetIds.includes(selected.id) ?? false}
              accessStateReady={myAccessRequests.isSuccess && !myAccessRequests.isFetching}
              accessStateError={myAccessRequests.isError}
              requesting={requestingAssetId === selected.id}
              request={
                myAccessRequests.data?.requests.find(
                  (candidate) => candidate.assetId === selected.id,
                ) ?? null
              }
              onRequest={(reason) => void requestAccess(selected, reason)}
            />
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

function DataAssetDetail({
  asset,
  activeUse,
  accessStateReady,
  accessStateError,
  requesting,
  request,
  onRequest,
}: {
  asset: DataAssetSummary;
  activeUse: boolean;
  accessStateReady: boolean;
  accessStateError: boolean;
  requesting: boolean;
  request: DataAccessRequest | null;
  onRequest: (reason?: string) => void;
}) {
  const { t } = useTranslation();
  const [entitlementReason, setEntitlementReason] = useState("");
  const privateOwnerAccess = asset.visibility === "private" && asset.kind !== "licensed-material";
  const ownerEntitlement = asset.visibility === "private" && asset.kind === "licensed-material";
  const requestPending = request?.status === "pending";
  const entitlementStatus = activeUse
    ? "active"
    : request?.status === "approved"
      ? "inactive"
      : request?.status;
  return (
    <Card data-testid="data-asset-detail">
      <CardHeader>
        <CardTitle>{asset.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{asset.description ?? t("dataMarket.noDescription")}</p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {t("dataMarket.lifecycle", { lifecycle: asset.lifecycle })}
          </Badge>
          <Badge variant="outline">{t("dataMarket.accessMode", { mode: asset.accessMode })}</Badge>
        </div>
        <div className="flex gap-2">
          <Badge>
            <Database />
            {t("dataMarket.permission.view")}
          </Badge>
          <Badge variant="outline">
            <LockKeyhole />
            {t("dataMarket.permission.useDownloadRequest")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {asset.lifecycle === "reviewing"
            ? t("dataMarket.reviewingRestriction")
            : t("dataMarket.centerRestriction")}
        </p>
        {entitlementStatus ? (
          <p data-testid="data-access-request-status">
            {t("dataMarket.requestStatus", { status: entitlementStatus })}
          </p>
        ) : null}
        {!accessStateReady ? (
          <p className="text-xs text-destructive" data-testid="data-access-state-unavailable">
            {accessStateError
              ? t("dataMarket.accessStateUnavailable")
              : t("dataMarket.accessStateLoading")}
          </p>
        ) : activeUse || requestPending ? null : privateOwnerAccess ? (
          <p data-testid="data-private-owner-access">{t("dataMarket.privateOwnerAccess")}</p>
        ) : ownerEntitlement ? (
          <div className="space-y-2">
            <Input
              value={entitlementReason}
              onChange={(event) => setEntitlementReason(event.target.value)}
              placeholder={t("dataMarket.ownerEntitlementReason")}
              aria-label={t("dataMarket.ownerEntitlementReason")}
            />
            <Button
              size="sm"
              disabled={!entitlementReason.trim() || requesting}
              onClick={() => onRequest(entitlementReason.trim())}
            >
              {requesting
                ? t("dataMarket.requestSubmitting")
                : t("dataMarket.requestOwnerEntitlement")}
            </Button>
          </div>
        ) : (
          <Button size="sm" disabled={requesting} onClick={() => onRequest()}>
            {requesting ? t("dataMarket.requestSubmitting") : t("dataMarket.requestAccess")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
