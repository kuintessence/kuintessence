import type {
  MirrorCacheRecord,
  SoftwareAccessRequest,
  SoftwareAssetSummary,
} from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Boxes,
  Check,
  CircleAlert,
  Code2,
  FlaskConical,
  GitBranch,
  PackagePlus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Undo2,
  Workflow,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import {
  completeDownstreamSoftwareGrants,
  createSoftwareAccessRequest,
  forkOfficialSoftwareAsset,
  listSoftwareAccessRequests,
  listSoftwareMirrorCacheStatus,
  listSoftwareReviewQueue,
  reviewSoftwareAccessRequest,
  reviewSoftwareAsset,
  submitSoftwareAsset,
  updateSoftwareAssetLifecycle,
} from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import {
  deleteSpackCatalogPackage,
  listSpackCatalog,
  listUsecasePackagePage,
  listWorkflowTemplatePage,
  SoftwareError,
  type SpackCatalogPackageUpdate,
  type SpackCatalogSourceFilter,
  type UsecasePackage,
  type UsecasePackageUpdate,
  updateSpackCatalogPackage,
  updateUsecasePackage,
  updateWorkflowTemplate,
  type WorkflowTemplate,
  type WorkflowTemplateUpdate,
} from "../../lib/software-client";
import {
  resolveSoftwareSection,
  SOFTWARE_SECTION_HASH,
  type SoftwareSection,
} from "../../lib/software-navigation";
import { useSoftwarePublishingAccess } from "../../lib/software-publishing-access";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { FunctionMaps } from "../function-maps/FunctionMaps";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorState, LoadingState } from "../ui/content-state";
import { ListToolbar } from "../ui/list-toolbar";
import { PageHeader, PageShell } from "../ui/page";
import { RefreshButton } from "../ui/refresh-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { LicenseEntitlementPanel } from "./EcosystemGovernancePanels";
import { RecipeRepositoriesPanel } from "./RecipeRepositoriesPanel";
import { SandboxScriptCatalog } from "./SandboxScriptCatalog";
import { AssetStatusBadges, WORKFLOW_TEMPLATE_PAGE_SIZE } from "./SoftwareCatalogControls";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";
import { SpackSoftwarePanel } from "./SpackSoftwarePanel";
import { sourceLabel } from "./software-fields";
import { SPACK_CATALOG_PAGE_SIZE } from "./spack-catalog";
import { UsecasePackagesPanel } from "./UsecasePackagesPanel";
import { describeTemplate, WorkflowTemplatesPanel } from "./WorkflowTemplatesPanel";

export { WORKFLOW_TEMPLATE_PAGE_SIZE } from "./SoftwareCatalogControls";
export { suggestNextTemplateVersion } from "./software-fields";
export { describeTemplate, type TemplateView } from "./WorkflowTemplatesPanel";

const SOFTWARE_FAVORITES_KEY = "kuintessence.software.favorites";

const SOFTWARE_STICKY_TOP = 0;

type SoftwareTab = SoftwareSection;

function readFavoriteKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(SOFTWARE_FAVORITES_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function useSoftwareFavorites(): {
  favorites: Set<string>;
  toggleFavorite: (key: string) => void;
} {
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavoriteKeys());
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SOFTWARE_FAVORITES_KEY, JSON.stringify([...favorites]));
  }, [favorites]);
  return {
    favorites,
    toggleFavorite: (key) =>
      setFavorites((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      }),
  };
}

function getActiveCreateLink(tab: SoftwareTab): {
  labelKey: string;
  testId: string;
  to:
    | "/software/workflow-templates/new"
    | "/software/usecases/new"
    | "/software/spack/new"
    | "/software/scripts/new";
} {
  if (tab === "scripts") {
    return {
      labelKey: "sandbox.catalog.create",
      testId: "software-create-script-link",
      to: "/software/scripts/new",
    };
  }
  if (tab === "usecases") {
    return {
      labelKey: "software.manage.createUsecasePage",
      testId: "software-create-usecase-link",
      to: "/software/usecases/new",
    };
  }
  if (tab === "spack") {
    return {
      labelKey: "software.manage.createCatalogPackagePage",
      testId: "software-create-spack-package-link",
      to: "/software/spack/new",
    };
  }
  return {
    labelKey: "software.manage.createTemplatePage",
    testId: "software-create-template-link",
    to: "/software/workflow-templates/new",
  };
}

function isSoftwareTab(value: string): value is SoftwareTab {
  return value === "templates" || value === "usecases" || value === "spack" || value === "scripts";
}

export function SoftwarePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const softwarePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const softwareHash = useRouterState({
    select: (state) => state.location.hash ?? "",
  });
  const queryClient = useQueryClient();
  const role = getAuthState().role;
  const { canPublish } = useSoftwarePublishingAccess();
  const canManagePlatform = role === "platform_admin" || role === "super_admin";
  const canManageOrganization = canPublish;
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [templatePage, setTemplatePage] = useState(1);
  const [usecaseSearch, setUsecaseSearch] = useState("");
  const [usecasePage, setUsecasePage] = useState(1);
  const activeTab = resolveSoftwareSection(softwarePathname, softwareHash) ?? "templates";
  const [spackCatalogSearch, setSpackCatalogSearch] = useState("");
  const [spackCatalogSource, setSpackCatalogSource] = useState<SpackCatalogSourceFilter>("all");
  const [spackCatalogPage, setSpackCatalogPage] = useState(1);
  const { favorites, toggleFavorite } = useSoftwareFavorites();
  const activeOrganizationId = useActiveOrganizationId();
  const templatesQ = useQuery({
    queryKey: ["software-templates", templatePage, search, activeTag],
    queryFn: () =>
      listWorkflowTemplatePage({
        page: templatePage,
        pageSize: WORKFLOW_TEMPLATE_PAGE_SIZE,
        q: search,
        tag: activeTag ?? undefined,
      }),
    refetchInterval: 30_000,
    retry: false,
  });
  const usecasesQ = useQuery({
    queryKey: ["software-usecases", activeOrganizationId, usecasePage, usecaseSearch],
    queryFn: () =>
      listUsecasePackagePage({
        orgId: activeOrganizationId ?? undefined,
        page: usecasePage,
        pageSize: WORKFLOW_TEMPLATE_PAGE_SIZE,
        q: usecaseSearch,
      }),
    refetchInterval: 30_000,
    retry: false,
  });
  const spackCatalogQ = useQuery({
    queryKey: ["software-spack-catalog", spackCatalogSearch, spackCatalogSource, spackCatalogPage],
    queryFn: () =>
      listSpackCatalog(
        spackCatalogSearch,
        SPACK_CATALOG_PAGE_SIZE,
        spackCatalogSource,
        spackCatalogPage,
      ),
    staleTime: 5 * 60_000,
    placeholderData: (previousData) => previousData,
    retry: false,
  });
  const reviewQueueQ = useQuery({
    queryKey: ["software-review-queue"],
    queryFn: () => listSoftwareReviewQueue(),
    refetchInterval: 30_000,
    retry: false,
    enabled: canManagePlatform,
  });
  const myAccessRequestsQ = useQuery({
    queryKey: ["software-access-requests", "mine"],
    queryFn: () => listSoftwareAccessRequests({ mine: true }),
    refetchInterval: 30_000,
    retry: false,
  });
  const pendingAccessRequestsQ = useQuery({
    queryKey: ["software-access-requests", "pending"],
    queryFn: () => listSoftwareAccessRequests({ status: "pending" }),
    refetchInterval: 30_000,
    retry: false,
    enabled: canManagePlatform,
  });
  const mirrorCacheQ = useQuery({
    queryKey: ["software-mirror-cache-status"],
    queryFn: () => listSoftwareMirrorCacheStatus(),
    refetchInterval: 60_000,
    retry: false,
    enabled: canManagePlatform,
  });

  const templateLoadError = templatesQ.error instanceof Error ? templatesQ.error : null;
  const usecaseLoadError = usecasesQ.error instanceof Error ? usecasesQ.error : null;
  const spackCatalogLoadError = spackCatalogQ.error instanceof Error ? spackCatalogQ.error : null;
  const reviewQueueLoadError = reviewQueueQ.error instanceof Error ? reviewQueueQ.error : null;
  const accessRequestsLoadError =
    myAccessRequestsQ.error instanceof Error ? myAccessRequestsQ.error : null;
  const pendingAccessRequestsLoadError =
    pendingAccessRequestsQ.error instanceof Error ? pendingAccessRequestsQ.error : null;
  const mirrorCacheLoadError = mirrorCacheQ.error instanceof Error ? mirrorCacheQ.error : null;
  const templatePageResult = templateLoadError ? null : (templatesQ.data ?? null);
  const items: WorkflowTemplate[] = templatePageResult?.templates ?? [];
  const usecasePageResult = usecaseLoadError ? null : (usecasesQ.data ?? null);
  const usecases: UsecasePackage[] = usecasePageResult?.usecasePackages ?? [];
  const spackCatalog = spackCatalogLoadError ? null : (spackCatalogQ.data ?? null);
  const reviewQueue = reviewQueueLoadError ? [] : (reviewQueueQ.data ?? []);
  const accessRequests = accessRequestsLoadError ? [] : (myAccessRequestsQ.data ?? []);
  const pendingAccessRequests = pendingAccessRequestsLoadError
    ? []
    : (pendingAccessRequestsQ.data ?? []);
  const mirrorCache = mirrorCacheLoadError ? [] : (mirrorCacheQ.data ?? []);
  const spackCatalogPackages = spackCatalog?.packages ?? [];
  const templateViews = useMemo(() => items.map(describeTemplate), [items]);
  const tags = templatePageResult?.tags ?? [];
  const visibleTemplates = templateViews;
  const visibleUsecases = usecases;
  const visibleSpackPackages = spackCatalogPackages;
  const updateSpackCatalogSearch = (value: string) => {
    setSpackCatalogSearch(value);
    setSpackCatalogPage(1);
  };
  const updateSpackCatalogSource = (value: SpackCatalogSourceFilter) => {
    setSpackCatalogSource(value);
    setSpackCatalogPage(1);
  };
  const activeDirectoryError =
    activeTab === "templates"
      ? templateLoadError
      : activeTab === "usecases"
        ? usecaseLoadError
        : activeTab === "spack"
          ? spackCatalogLoadError
          : null;
  const isUnreachable =
    activeDirectoryError instanceof SoftwareError && activeDirectoryError.status >= 500;
  const isMissing =
    activeDirectoryError instanceof SoftwareError &&
    (activeDirectoryError.status === 404 || activeDirectoryError.status === 503);
  const canRequestAccess = !accessRequestsLoadError;
  const canSubmitAssets = canManageOrganization && !reviewQueueLoadError;
  const hasTemplateFilter = search.trim() !== "" || activeTag !== null;
  const hasUsecaseFilter = usecaseSearch.trim() !== "";
  const isFetching = templatesQ.isFetching || usecasesQ.isFetching || spackCatalogQ.isFetching;
  const directoryLoading = <LoadingState>{t("common.loading")}</LoadingState>;
  const activeCreateLink = getActiveCreateLink(activeTab);
  const canCreateActiveArtifact =
    canManageOrganization && (activeTab !== "templates" || canManagePlatform);
  const updateActiveTab = (tab: SoftwareTab) => {
    void navigate({ to: "/software", hash: SOFTWARE_SECTION_HASH[tab] });
  };
  const updateTemplateSearch = (value: string) => {
    setSearch(value);
    setTemplatePage(1);
  };
  const updateTemplateTag = (value: string | null) => {
    setActiveTag(value);
    setTemplatePage(1);
  };
  const updateUsecaseSearch = (value: string) => {
    setUsecaseSearch(value);
    setUsecasePage(1);
  };
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["software-templates"] });
    void queryClient.invalidateQueries({ queryKey: ["software-usecases"] });
    void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
    void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
    void queryClient.invalidateQueries({ queryKey: ["software-access-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["software-mirror-cache-status"] });
    void queryClient.invalidateQueries({ queryKey: ["sandbox-scripts"] });
  };
  const updateTemplate = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: WorkflowTemplateUpdate }) =>
      updateWorkflowTemplate(id, payload),
    onSuccess: (template, variables) => {
      toast.success(
        template.id === variables.id
          ? t("software.manage.templateUnchanged")
          : t("software.manage.templateVersionCreated"),
      );
      void queryClient.invalidateQueries({ queryKey: ["software-templates"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.updateFailed"))),
  });
  const updateCatalogPackage = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SpackCatalogPackageUpdate }) =>
      updateSpackCatalogPackage(
        id,
        payload,
        payload.source === "vendor" ? (activeOrganizationId ?? undefined) : undefined,
      ),
    onSuccess: () => {
      toast.success(t("software.manage.catalogPackageUpdated"));
      void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.updateFailed"))),
  });
  const removeCatalogPackage = useMutation({
    mutationFn: deleteSpackCatalogPackage,
    onSuccess: () => {
      toast.success(t("software.manage.catalogPackageDeleted"));
      void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.deleteFailed"))),
  });
  const updateUsecase = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UsecasePackageUpdate }) =>
      updateUsecasePackage(id, payload),
    onSuccess: (pkg, variables) => {
      toast.success(
        pkg.id === variables.id
          ? t("software.manage.templateUnchanged")
          : t("software.manage.templateVersionCreated"),
      );
      void queryClient.invalidateQueries({ queryKey: ["software-usecases"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.updateFailed"))),
  });
  const submitAsset = useMutation({
    mutationFn: (assetId: string) => submitSoftwareAsset(assetId, "submitted from Software Center"),
    onSuccess: () => {
      toast.success(t("software.governance.submitted"));
      void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const reviewAsset = useMutation({
    mutationFn: ({ assetId, decision }: { assetId: string; decision: "approved" | "rejected" }) =>
      reviewSoftwareAsset(assetId, decision, `${decision} from Software Center review console`),
    onSuccess: () => {
      toast.success(t("software.governance.reviewed"));
      void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const forkAsset = useMutation({
    mutationFn: forkOfficialSoftwareAsset,
    onSuccess: () => {
      toast.success(t("software.governance.forked"));
      void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const lifecycleAsset = useMutation({
    mutationFn: ({
      assetId,
      lifecycle,
    }: {
      assetId: string;
      lifecycle: "deprecated" | "revoked";
    }) =>
      updateSoftwareAssetLifecycle(
        assetId,
        lifecycle,
        `${lifecycle} from Software Center review console`,
      ),
    onSuccess: () => {
      toast.success(t("software.governance.lifecycleUpdated"));
      void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const completeGrants = useMutation({
    mutationFn: (asset: SoftwareAssetSummary) =>
      completeDownstreamSoftwareGrants({
        assetRef: { kind: asset.kind, id: asset.id },
        capabilities: ["use"],
        reason: "completed downstream use grant from Software Center",
      }),
    onSuccess: (result) => {
      toast.success(t("software.governance.grantsCompleted", { count: result.completed.length }));
      void queryClient.invalidateQueries({ queryKey: ["software-review-queue"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const requestAccess = useMutation({
    mutationFn: (asset: SoftwareAssetSummary) =>
      createSoftwareAccessRequest({
        assetRef: { kind: asset.kind, id: asset.id },
        capability: "install",
        reason: "requested from Software catalog",
      }),
    onSuccess: () => {
      toast.success(t("software.access.requested"));
      void queryClient.invalidateQueries({ queryKey: ["software-access-requests"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });
  const reviewAccess = useMutation({
    mutationFn: ({
      requestId,
      decision,
    }: {
      requestId: string;
      decision: "approved" | "rejected";
    }) => reviewSoftwareAccessRequest(requestId, decision, `${decision} from Software governance`),
    onSuccess: () => {
      toast.success(t("software.access.reviewed"));
      void queryClient.invalidateQueries({ queryKey: ["software-access-requests"] });
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.governance.actionFailed"))),
  });

  return (
    <PageShell data-testid="software-page">
      <PageHeader
        title={t("software.title")}
        actions={
          <>
            {canCreateActiveArtifact ? (
              activeDirectoryError ? (
                <Button size="sm" disabled data-testid={activeCreateLink.testId}>
                  <PackagePlus />
                  {t(activeCreateLink.labelKey)}
                </Button>
              ) : (
                <Button asChild size="sm" data-testid={activeCreateLink.testId}>
                  <Link to={activeCreateLink.to}>
                    <PackagePlus />
                    {t(activeCreateLink.labelKey)}
                  </Link>
                </Button>
              )
            ) : null}
            <RefreshButton
              variant="outline"
              onClick={refreshAll}
              disabled={isFetching}
              data-testid="software-refresh"
              label={t("common.refresh", { defaultValue: "刷新" })}
            >
              <RefreshCw className={cn(isFetching && "animate-spin")} />
            </RefreshButton>
          </>
        }
      />

      {activeTab === "templates" ? <FunctionMaps ids={["D04"]} /> : null}
      {activeTab === "spack" ? <FunctionMaps ids={["G17"]} /> : null}
      {canManagePlatform ? (
        <SoftwareGovernancePanel
          assets={reviewQueue}
          completeGrants={(asset) => completeGrants.mutate(asset)}
          forkAsset={(assetId) => forkAsset.mutate(assetId)}
          isLoading={reviewQueueQ.isLoading}
          rejectAsset={(assetId) => reviewAsset.mutate({ assetId, decision: "rejected" })}
          reviewAsset={(assetId) => reviewAsset.mutate({ assetId, decision: "approved" })}
          revokeAsset={(assetId) => lifecycleAsset.mutate({ assetId, lifecycle: "revoked" })}
          deprecateAsset={(assetId) => lifecycleAsset.mutate({ assetId, lifecycle: "deprecated" })}
        />
      ) : null}

      {canManagePlatform && reviewQueueLoadError ? (
        <AuxiliaryErrorBanner error={reviewQueueLoadError} testId="software-review-queue-error" />
      ) : null}
      {accessRequestsLoadError || (canManagePlatform && pendingAccessRequestsLoadError) ? (
        <AuxiliaryErrorBanner
          error={accessRequestsLoadError ?? pendingAccessRequestsLoadError}
          testId="software-access-requests-error"
        />
      ) : null}
      {canManagePlatform && mirrorCacheLoadError ? (
        <AuxiliaryErrorBanner error={mirrorCacheLoadError} testId="software-mirror-cache-error" />
      ) : null}

      <details className="border-b border-border" data-testid="software-management">
        <summary className="cursor-pointer px-2 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {t("software.management")}
        </summary>
        <div className="kq-motion--disclosure space-y-4 border-border p-4">
          <SoftwareRoleFlowPanel
            accessRequests={accessRequests}
            canRequestAccess={canRequestAccess}
            mirrorCache={mirrorCache}
            pendingAccessRequests={pendingAccessRequests}
            publisherAssets={spackCatalogPackages.flatMap((pkg) => (pkg.asset ? [pkg.asset] : []))}
            reviewAssets={reviewQueue}
            showOperations={canManagePlatform}
            requestAccess={(asset) => {
              if (canRequestAccess) requestAccess.mutate(asset);
            }}
            reviewAccess={(requestId, decision) => reviewAccess.mutate({ requestId, decision })}
          />

          <FunctionMaps ids={["G18"]} />
          <LicenseEntitlementPanel
            canReview={canManagePlatform}
            canSubmit={canManageOrganization}
            defaultClaimantId={getAuthState().email}
          />
        </div>
      </details>

      {isMissing || isUnreachable ? (
        <div className=" border-border p-4 text-sm" data-testid="software-banner-unreachable">
          <div className="flex items-center gap-2 font-medium">
            <CircleAlert className="h-4 w-4 text-[var(--status-failed)]" />
            {t("software.unreachable")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("software.unreachableDesc")}</p>
        </div>
      ) : null}

      {activeDirectoryError && !isMissing && !isUnreachable ? (
        <ErrorState data-testid="software-error">
          {toUserFacingError(activeDirectoryError, t("software.unreachable"))}
        </ErrorState>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isSoftwareTab(value)) updateActiveTab(value);
        }}
        className="space-y-3"
      >
        <SoftwareStickyControls
          activeTab={activeTab}
          activeTag={activeTag}
          search={search}
          setActiveTag={updateTemplateTag}
          setSearch={updateTemplateSearch}
          setSpackCatalogSearch={updateSpackCatalogSearch}
          setSpackCatalogSource={updateSpackCatalogSource}
          setUsecaseSearch={updateUsecaseSearch}
          spackCatalogSearch={spackCatalogSearch}
          spackCatalogSource={spackCatalogSource}
          tags={tags}
          usecaseSearch={usecaseSearch}
        />
        <TabsContent value="templates">
          {templateLoadError ? null : templatesQ.isPending ? (
            directoryLoading
          ) : (
            <WorkflowTemplatesPanel
              canManage={canManagePlatform}
              favorites={favorites}
              hasFilter={hasTemplateFilter}
              hasNext={templatePageResult?.hasNext ?? false}
              page={templatePageResult?.page ?? templatePage}
              setActiveTag={updateTemplateTag}
              setPage={setTemplatePage}
              setSearch={updateTemplateSearch}
              toggleFavorite={toggleFavorite}
              updateTemplate={(id, payload, onSuccess) =>
                updateTemplate.mutate({ id, payload }, { onSuccess })
              }
              updateTemplatePending={updateTemplate.isPending}
              total={templatePageResult?.total ?? 0}
              visibleTemplates={visibleTemplates}
            />
          )}
        </TabsContent>
        <TabsContent value="usecases">
          {usecaseLoadError ? null : usecasesQ.isPending ? (
            directoryLoading
          ) : (
            <UsecasePackagesPanel
              canManage={canManageOrganization}
              catalog={spackCatalog}
              catalogSearch={spackCatalogSearch}
              catalogSource={spackCatalogSource}
              favorites={favorites}
              hasFilter={hasUsecaseFilter}
              hasNext={usecasePageResult?.hasNext ?? false}
              page={usecasePageResult?.page ?? usecasePage}
              setCatalogPage={setSpackCatalogPage}
              setCatalogSearch={updateSpackCatalogSearch}
              setCatalogSource={updateSpackCatalogSource}
              setPage={setUsecasePage}
              toggleFavorite={toggleFavorite}
              total={usecasePageResult?.total ?? 0}
              updateUsecase={(id, payload, onSuccess) =>
                updateUsecase.mutate({ id, payload }, { onSuccess })
              }
              updateUsecasePending={updateUsecase.isPending}
              usecases={visibleUsecases}
            />
          )}
        </TabsContent>
        <TabsContent value="spack">
          <details
            className="mb-4 border-b border-border"
            data-testid="software-material-management"
          >
            <summary className="cursor-pointer px-2 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              {t("software.materialManagement")}
            </summary>
            <div className="kq-motion--disclosure space-y-4 border-border p-4">
              <FunctionMaps ids={["G19"]} />
              <RecipeRepositoriesPanel canManage={canManageOrganization} />
              <SpackMaterialsPanel canManage={canManageOrganization} canManageBindings />
            </div>
          </details>
          {spackCatalogLoadError ? null : spackCatalogQ.isPending ? (
            directoryLoading
          ) : (
            <SpackSoftwarePanel
              canManage={canManageOrganization}
              canManagePlatform={canManagePlatform}
              favorites={favorites}
              activeOrganizationId={activeOrganizationId}
              removeCatalogPackage={(id, onSuccess) =>
                removeCatalogPackage.mutate(id, { onSuccess })
              }
              removeCatalogPackagePending={removeCatalogPackage.isPending}
              canRequestAccess={canRequestAccess}
              canSubmitAssets={canSubmitAssets}
              requestAccess={(asset) => {
                if (canRequestAccess) requestAccess.mutate(asset);
              }}
              submitAsset={(assetId) => {
                if (canSubmitAssets) submitAsset.mutate(assetId);
              }}
              spackCatalog={spackCatalog}
              spackCatalogPackages={visibleSpackPackages}
              setSpackCatalogPage={setSpackCatalogPage}
              toggleFavorite={toggleFavorite}
              updateCatalogPackage={(id, payload, onSuccess) =>
                updateCatalogPackage.mutate({ id, payload }, { onSuccess })
              }
              updateCatalogPackagePending={updateCatalogPackage.isPending}
            />
          )}
        </TabsContent>
        <TabsContent value="scripts">
          <SandboxScriptCatalog embedded />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function SoftwareStickyControls({
  activeTab,
  activeTag,
  search,
  setActiveTag,
  setSearch,
  setSpackCatalogSearch,
  setSpackCatalogSource,
  setUsecaseSearch,
  spackCatalogSearch,
  spackCatalogSource,
  tags,
  usecaseSearch,
}: {
  activeTab: SoftwareTab;
  activeTag: string | null;
  search: string;
  setActiveTag: (tag: string | null) => void;
  setSearch: (value: string) => void;
  setSpackCatalogSearch: (value: string) => void;
  setSpackCatalogSource: (value: SpackCatalogSourceFilter) => void;
  setUsecaseSearch: (value: string) => void;
  spackCatalogSearch: string;
  spackCatalogSource: SpackCatalogSourceFilter;
  tags: string[];
  usecaseSearch: string;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [fixedFrame, setFixedFrame] = useState({
    fixed: false,
    height: 0,
    left: 0,
    width: 0,
  });
  useEffect(() => {
    const updateFrame = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setFixedFrame((current) => {
        const next = {
          fixed: rect.top <= SOFTWARE_STICKY_TOP,
          height: Math.round(rect.height || current.height),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
        };
        return current.fixed === next.fixed &&
          current.height === next.height &&
          current.left === next.left &&
          current.width === next.width
          ? current
          : next;
      });
    };
    updateFrame();
    window.addEventListener("scroll", updateFrame, { passive: true });
    window.addEventListener("resize", updateFrame);
    return () => {
      window.removeEventListener("scroll", updateFrame);
      window.removeEventListener("resize", updateFrame);
    };
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (anchorRef.current?.dataset.activeTab === activeTab) {
        window.dispatchEvent(new Event("resize"));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab]);
  return (
    <div
      ref={anchorRef}
      style={fixedFrame.fixed ? { height: fixedFrame.height } : undefined}
      data-active-tab={activeTab}
      data-testid="software-sticky-anchor"
    >
      <div
        className={cn(
          "space-y-3 py-2 backdrop-blur ",
          fixedFrame.fixed ? "fixed z-30 border-b border-border px-0 " : "relative z-10 -mx-1 px-1",
        )}
        style={
          fixedFrame.fixed
            ? { left: fixedFrame.left, right: 0, top: SOFTWARE_STICKY_TOP }
            : undefined
        }
        data-fixed={fixedFrame.fixed ? "true" : "false"}
        data-testid="software-sticky-controls"
      >
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="templates" data-testid="software-tab-templates">
            <Workflow />
            {t("software.tabs.templates")}
          </TabsTrigger>
          <TabsTrigger value="usecases" data-testid="software-tab-usecases">
            <FlaskConical />
            {t("software.tabs.usecases")}
          </TabsTrigger>
          <TabsTrigger value="spack" data-testid="software-tab-spack">
            <Boxes />
            {t("software.tabs.spack")}
          </TabsTrigger>
          <TabsTrigger value="scripts" data-testid="software-tab-scripts">
            <Code2 />
            {t("software.tabs.scripts")}
          </TabsTrigger>
        </TabsList>
        {activeTab === "templates" ? (
          <CatalogToolbar
            activeTag={activeTag}
            search={search}
            searchPlaceholder={t("software.searchPlaceholder")}
            searchTestId="software-search"
            setActiveTag={setActiveTag}
            setSearch={setSearch}
            tagTestId="software-tag-filters"
            tags={tags}
            variant={fixedFrame.fixed ? "sticky" : "card"}
          />
        ) : null}
        {activeTab === "usecases" ? (
          <CatalogToolbar
            activeTag={null}
            search={usecaseSearch}
            searchPlaceholder={t("software.usecaseSearchPlaceholder")}
            searchTestId="software-usecase-search"
            setActiveTag={() => undefined}
            setSearch={setUsecaseSearch}
            tags={[]}
            variant={fixedFrame.fixed ? "sticky" : "card"}
          />
        ) : null}
        {activeTab === "spack" ? (
          <CatalogToolbar
            activeTag={null}
            search={spackCatalogSearch}
            searchPlaceholder={t("software.manage.catalogSearch")}
            searchTestId="software-spack-catalog-search"
            setActiveTag={() => undefined}
            setSearch={setSpackCatalogSearch}
            tagTestId="software-spack-tag-filters"
            tags={[]}
            variant={fixedFrame.fixed ? "sticky" : "card"}
          >
            {(["all", "upstream", "official", "vendor"] satisfies SpackCatalogSourceFilter[]).map(
              (item) => (
                <TagButton
                  key={item}
                  active={spackCatalogSource === item}
                  onClick={() => setSpackCatalogSource(item)}
                >
                  {sourceLabel(t, item)}
                </TagButton>
              ),
            )}
          </CatalogToolbar>
        ) : null}
      </div>
    </div>
  );
}

function AuxiliaryErrorBanner({ error, testId }: { error: Error | null; testId: string }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className=" p-3 text-sm" data-testid={testId}>
      {toUserFacingError(error, t("software.governance.actionFailed"))}
    </div>
  );
}

function SoftwareRoleFlowPanel({
  accessRequests,
  canRequestAccess,
  mirrorCache,
  pendingAccessRequests,
  publisherAssets,
  requestAccess,
  reviewAccess,
  reviewAssets,
  showOperations,
}: {
  accessRequests: SoftwareAccessRequest[];
  canRequestAccess: boolean;
  mirrorCache: MirrorCacheRecord[];
  pendingAccessRequests: SoftwareAccessRequest[];
  publisherAssets: SoftwareAssetSummary[];
  requestAccess: (asset: SoftwareAssetSummary) => void;
  reviewAccess: (requestId: string, decision: "approved" | "rejected") => void;
  reviewAssets: SoftwareAssetSummary[];
  showOperations: boolean;
}) {
  const { t } = useTranslation();
  const requestableAsset = publisherAssets.find(
    (asset) => asset.lifecycle === "published" || asset.lifecycle === "draft",
  );
  const latestAccessRequest = accessRequests[0] ?? null;
  const pendingAccessRequest = pendingAccessRequests[0] ?? null;
  const cacheCounts: Record<string, number> = {};
  for (const item of mirrorCache) {
    cacheCounts[item.status] = (cacheCounts[item.status] ?? 0) + 1;
  }
  return (
    <section
      className={cn("grid gap-3 sm:grid-cols-2", showOperations && "2xl:grid-cols-4")}
      data-testid="software-role-flow-panel"
    >
      <div className=" border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("software.roles.user")}</h3>
          <Badge variant="outline">{accessRequests.length}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("software.roles.userDesc")}</p>
        {latestAccessRequest ? (
          <div className="mt-2 truncate text-xs">
            {latestAccessRequest.asset.name} ·{" "}
            {t(`software.access.status.${latestAccessRequest.status}`)}
          </div>
        ) : null}
        {requestableAsset ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={!canRequestAccess}
            onClick={() => requestAccess(requestableAsset)}
            data-testid="software-request-first-access"
          >
            <ShieldAlert />
            {t("software.access.requestInstall")}
          </Button>
        ) : null}
      </div>
      <div className=" border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("software.roles.publisher")}</h3>
          <Badge variant="outline">{publisherAssets.length}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("software.roles.publisherDesc")}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {publisherAssets.slice(0, 4).map((asset) => (
            <Badge key={asset.id} variant={asset.lifecycle === "published" ? "brand" : "outline"}>
              {asset.name}: {t(`software.governance.lifecycle.${asset.lifecycle}`)}
            </Badge>
          ))}
        </div>
      </div>
      {showOperations ? (
        <div className=" border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t("software.roles.operator")}</h3>
            <Badge variant="outline">{reviewAssets.length + pendingAccessRequests.length}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("software.roles.operatorDesc")}</p>
          {pendingAccessRequest ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-border p-2">
              <span className="truncate text-xs">
                {pendingAccessRequest.asset.name} · {pendingAccessRequest.capability}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => reviewAccess(pendingAccessRequest.id, "approved")}
                >
                  <Check />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => reviewAccess(pendingAccessRequest.id, "rejected")}
                >
                  <X />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {showOperations ? (
        <div className=" border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t("software.roles.mirror")}</h3>
            <Badge variant="outline">{mirrorCache.length}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("software.roles.mirrorDesc")}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {["cached", "syncing", "missing", "failed"].map((status) => (
              <Badge key={status} variant={status === "failed" ? "cancelled" : "outline"}>
                {status}: {cacheCounts[status] ?? 0}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SoftwareGovernancePanel({
  assets,
  completeGrants,
  deprecateAsset,
  forkAsset,
  isLoading,
  rejectAsset,
  reviewAsset,
  revokeAsset,
}: {
  assets: SoftwareAssetSummary[];
  completeGrants: (asset: SoftwareAssetSummary) => void;
  deprecateAsset: (assetId: string) => void;
  forkAsset: (assetId: string) => void;
  isLoading: boolean;
  rejectAsset: (assetId: string) => void;
  reviewAsset: (assetId: string) => void;
  revokeAsset: (assetId: string) => void;
}) {
  const { t } = useTranslation();
  if (!isLoading && assets.length === 0) return null;
  return (
    <section className="space-y-3 border-border p-3" data-testid="software-governance-panel">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("software.governance.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("software.governance.subtitle")}</p>
        </div>
        <Badge variant="outline">
          {isLoading
            ? t("common.loading")
            : t("software.governance.pending", { count: assets.length })}
        </Badge>
      </div>
      {assets.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-2">
          {assets.slice(0, 6).map((asset) => (
            <div
              key={asset.id}
              className="grid gap-2 border-border p-2.5"
              data-testid={`software-review-asset-${asset.id}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm font-semibold text-foreground">
                    {asset.name}@{asset.version}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <AssetStatusBadges asset={asset} />
                  </div>
                </div>
                <Badge variant={asset.trustedForGlobalUse ? "brand" : "outline"}>
                  {asset.trustedForGlobalUse
                    ? t("software.governance.trusted")
                    : t("software.governance.untrusted")}
                </Badge>
              </div>
              <div className="kq-fill-row gap-1 border-border pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => reviewAsset(asset.id)}
                >
                  <Check />
                  {t("software.governance.approve")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => forkAsset(asset.id)}
                >
                  <GitBranch />
                  {t("software.governance.forkOfficial")}
                </Button>
                {asset.kind === "workflow-template" || asset.kind === "usecase" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => completeGrants(asset)}
                  >
                    <GitBranch />
                    {t("software.governance.completeGrants")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => deprecateAsset(asset.id)}
                >
                  <Undo2 />
                  {t("software.governance.deprecate")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => rejectAsset(asset.id)}
                >
                  <X />
                  {t("software.governance.reject")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => revokeAsset(asset.id)}
                >
                  <Trash2 />
                  {t("software.governance.revoke")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TagButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="aria-pressed:bg-brand-soft aria-pressed:font-semibold aria-pressed:text-brand"
      size="sm"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function CatalogToolbar({
  activeTag,
  children,
  search,
  searchPlaceholder,
  searchTestId,
  setActiveTag,
  setSearch,
  tagTestId,
  tags,
  variant = "card",
}: {
  activeTag: string | null;
  children?: ReactNode;
  search: string;
  searchPlaceholder: string;
  searchTestId: string;
  setActiveTag: (tag: string | null) => void;
  setSearch: (value: string) => void;
  tagTestId?: string;
  tags: string[];
  variant?: "card" | "sticky";
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("space-y-3 p-3", variant === "card" ? " border-border" : " ")}>
      <ListToolbar
        search={{
          "aria-label": searchPlaceholder,
          value: search,
          onChange: (e) => setSearch(e.target.value),
          placeholder: searchPlaceholder,
          "data-testid": searchTestId,
        }}
        actions={
          search ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSearch("")}>
              <X />
              {t("software.clearSearch")}
            </Button>
          ) : null
        }
      />
      {tags.length > 0 || activeTag || children ? (
        <div className="kq-fill-row gap-1.5 sm:[&>button]:flex-none" data-testid={tagTestId}>
          {tags.length > 0 || activeTag ? (
            <TagButton active={activeTag === null} onClick={() => setActiveTag(null)}>
              {t("common.all", { defaultValue: "全部" })}
            </TagButton>
          ) : null}
          {tags.map((tag) => (
            <TagButton key={tag} active={activeTag === tag} onClick={() => setActiveTag(tag)}>
              {tag}
            </TagButton>
          ))}
          {children}
        </div>
      ) : null}
    </div>
  );
}
