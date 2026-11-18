import type {
  MirrorCacheRecord,
  SoftwareAccessRequest,
  SoftwareAssetSummary,
} from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Box,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  Edit3,
  Eye,
  FlaskConical,
  GitBranch,
  Loader2,
  PackagePlus,
  RefreshCw,
  Save,
  ShieldAlert,
  Star,
  Trash2,
  Undo2,
  Workflow,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  type SpackCatalog,
  type SpackCatalogPackage,
  type SpackCatalogPackageCreate,
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
import { parsePublishedWorkflowTemplate, summarize } from "../../lib/workflow-parser";
import { FunctionMaps } from "../function-maps/FunctionMaps";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorState, LoadingState } from "../ui/content-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { FormField } from "../ui/form-field";
import { Input, Textarea } from "../ui/input";
import { ListToolbar } from "../ui/list-toolbar";
import { NativeSelect } from "../ui/native-select";
import { PageHeader, PageShell } from "../ui/page";
import { PaginationControls } from "../ui/pagination-controls";
import { RefreshButton } from "../ui/refresh-button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { CatalogEmptyState } from "./CatalogEmptyState";
import {
  cardActionLayerClass,
  cardContentLayerClass,
  cardSurfaceLinkClass,
  clickableCardClass,
} from "./card-navigation";
import { LicenseEntitlementPanel } from "./EcosystemGovernancePanels";
import { RecipeRepositoriesPanel } from "./RecipeRepositoriesPanel";
import { SandboxScriptCatalog } from "./SandboxScriptCatalog";
import { SmallEmpty } from "./SmallEmpty";
import { SoftwareCard } from "./SoftwareCard";
import { SoftwareCardGrid } from "./SoftwareCardGrid";
import { CatalogPackagePickerField, SpackCatalogPickerDialog } from "./SpackCatalogPicker";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";
import { SpackSpecConfigSheet, SpackSpecPickerField } from "./SpackSpecPicker";
import { optionalText, parseTagInput, sourceLabel } from "./software-fields";
import { catalogPackageKey, SPACK_CATALOG_PAGE_SIZE } from "./spack-catalog";
import { makeUsecaseSpec } from "./spack-spec";

export interface TemplateView {
  template: WorkflowTemplate;
  nodeCount: number | null;
  edgeCount: number | null;
  nodeTypes: string[];
  usecaseRefs: string[];
  softwareRefs: string[];
  isValidWorkflow: boolean;
}

export const WORKFLOW_TEMPLATE_PAGE_SIZE = 24;
const SOFTWARE_FAVORITES_KEY = "kuintessence.software.favorites";
const SOFTWARE_STICKY_TOP = 0;
type SoftwareTab = SoftwareSection;

export function describeTemplate(template: WorkflowTemplate): TemplateView {
  const parsed = parsePublishedWorkflowTemplate(template.yamlContent);
  if (!parsed.ok) {
    return {
      template,
      nodeCount: null,
      edgeCount: null,
      nodeTypes: [],
      usecaseRefs: [],
      softwareRefs: [],
      isValidWorkflow: false,
    };
  }
  const summary = summarize(parsed.workflow);
  const refs = collectWorkflowRefs(parsed.workflow.spec.nodeDrafts);
  return {
    template,
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
    nodeTypes: summary.nodeTypes,
    usecaseRefs: refs.usecaseRefs,
    softwareRefs: refs.softwareRefs,
    isValidWorkflow: true,
  };
}

function collectWorkflowRefs(nodes: unknown[]): { usecaseRefs: string[]; softwareRefs: string[] } {
  const usecaseRefs = new Set<string>();
  const softwareRefs = new Set<string>();
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const usecase = record.usecaseVersionId;
    const software = record.softwareVersionId;
    if (typeof usecase === "string") usecaseRefs.add(usecase);
    if (typeof software === "string") softwareRefs.add(software);
  }
  return {
    usecaseRefs: [...usecaseRefs],
    softwareRefs: [...softwareRefs],
  };
}

function favoriteKey(kind: "template" | "usecase" | "spack", id: string): string {
  return `${kind}:${id}`;
}

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
                <Button
                  key={item}
                  type="button"
                  variant={spackCatalogSource === item ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSpackCatalogSource(item)}
                >
                  {sourceLabel(t, item)}
                </Button>
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

function AssetStatusBadges({ asset }: { asset: SoftwareAssetSummary }) {
  const { t } = useTranslation();
  return (
    <>
      <Badge variant="outline">{t(`software.governance.kind.${asset.kind}`)}</Badge>
      <Badge variant="outline">{t(`software.governance.source.${asset.source}`)}</Badge>
      <Badge variant={asset.lifecycle === "published" ? "brand" : "outline"}>
        {t(`software.governance.lifecycle.${asset.lifecycle}`)}
      </Badge>
      <Badge variant="outline">{t(`software.governance.visibility.${asset.visibility}`)}</Badge>
    </>
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
      variant={active ? "default" : "outline"}
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
      {tags.length > 0 || children ? (
        <div className="kq-fill-row gap-1.5" data-testid={tagTestId}>
          <TagButton active={activeTag === null} onClick={() => setActiveTag(null)}>
            {t("common.all", { defaultValue: "全部" })}
          </TagButton>
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

function ServerPagination({
  hasNext,
  page,
  setPage,
  shown,
  total,
}: {
  hasNext: boolean;
  page: number;
  setPage: (value: number) => void;
  shown: number;
  total: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>{t("software.pageResultCount", { shown, total })}</span>
      <PaginationControls
        previous={{
          disabled: page <= 1,
          onClick: () => setPage(Math.max(1, page - 1)),
          "data-testid": "software-template-previous-page",
          children: (
            <>
              <ChevronLeft />
              {t("software.manage.previousPage")}
            </>
          ),
        }}
        next={{
          disabled: !hasNext,
          onClick: () => setPage(page + 1),
          "data-testid": "software-template-next-page",
          children: (
            <>
              {t("software.manage.nextPage")}
              <ChevronRight />
            </>
          ),
        }}
      >
        <span className="font-mono text-[11px]">
          {t("software.manage.catalogPageStatus", {
            page,
            total: Math.max(1, Math.ceil(total / WORKFLOW_TEMPLATE_PAGE_SIZE)),
          })}
        </span>
      </PaginationControls>
    </div>
  );
}

function FavoriteButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? t("software.unfavorite") : t("software.favorite")}
    >
      <Star className={cn(active && "fill-current")} />
      <span className="sr-only">{active ? t("software.unfavorite") : t("software.favorite")}</span>
    </Button>
  );
}

function WorkflowTemplatesPanel({
  canManage,
  favorites,
  hasFilter,
  hasNext,
  page,
  setActiveTag,
  setPage,
  setSearch,
  toggleFavorite,
  total,
  updateTemplate,
  updateTemplatePending,
  visibleTemplates,
}: {
  canManage: boolean;
  favorites: Set<string>;
  hasFilter: boolean;
  hasNext: boolean;
  page: number;
  setActiveTag: (tag: string | null) => void;
  setPage: (value: number) => void;
  setSearch: (value: string) => void;
  toggleFavorite: (key: string) => void;
  total: number;
  updateTemplate: (id: string, payload: WorkflowTemplateUpdate, onSuccess: () => void) => void;
  updateTemplatePending: boolean;
  visibleTemplates: TemplateView[];
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingView = visibleTemplates.find((view) => view.template.id === editingId) ?? null;
  return (
    <div className="space-y-4">
      {visibleTemplates.length > 0 ? (
        <div className="space-y-3">
          <ServerPagination
            hasNext={hasNext}
            page={page}
            setPage={setPage}
            shown={visibleTemplates.length}
            total={total}
          />
          <SoftwareCardGrid className="gap-3" data-testid="software-grid">
            {visibleTemplates.map((view) => {
              const key = favoriteKey("template", view.template.id);
              return (
                <SoftwareCard
                  key={view.template.id}
                  favorite={favorites.has(key)}
                  onEdit={canManage ? () => setEditingId(view.template.id) : undefined}
                  onToggleFavorite={() => toggleFavorite(key)}
                  view={view}
                />
              );
            })}
          </SoftwareCardGrid>
          {canManage && editingView ? (
            <Sheet
              open={true}
              onOpenChange={(open) => !open && !updateTemplatePending && setEditingId(null)}
            >
              <SheetContent
                width="max-w-2xl"
                data-testid="software-template-edit-sheet"
                dismissible={!updateTemplatePending}
              >
                <SheetHeader>
                  <SheetTitle>{t("software.manage.publishTemplateVersion")}</SheetTitle>
                  <SheetDescription>
                    {t("software.manage.editTemplateVersionHint")}
                  </SheetDescription>
                </SheetHeader>
                <SheetBody>
                  <WorkflowTemplateEditForm
                    isPending={updateTemplatePending}
                    template={editingView.template}
                    onCancel={() => setEditingId(null)}
                    onSubmit={(payload) => {
                      updateTemplate(editingView.template.id, payload, () => setEditingId(null));
                    }}
                  />
                </SheetBody>
              </SheetContent>
            </Sheet>
          ) : null}
          <ServerPagination
            hasNext={hasNext}
            page={page}
            setPage={setPage}
            shown={visibleTemplates.length}
            total={total}
          />
        </div>
      ) : total > 0 ? (
        <div
          className="flex h-36 flex-col items-center justify-center gap-2 border-border text-sm text-muted-foreground"
          data-testid="software-no-matches"
        >
          <Box className="h-5 w-5" />
          <span>{t("software.noMatches")}</span>
          {hasFilter ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setActiveTag(null);
              }}
            >
              {t("software.clearFilters")}
            </Button>
          ) : null}
        </div>
      ) : (
        <SoftwareEmptyState canCreate={canManage} />
      )}
    </div>
  );
}

function WorkflowTemplateEditForm({
  isPending,
  onCancel,
  onSubmit,
  template,
}: {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (payload: WorkflowTemplateUpdate) => void;
  template: WorkflowTemplate;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(template.name);
  const [version, setVersion] = useState(() => suggestNextTemplateVersion(template.version));
  const [description, setDescription] = useState(template.description ?? "");
  const [tags, setTags] = useState(template.tags.join(","));
  const [yamlContent, setYamlContent] = useState(template.yamlContent);
  return (
    <form
      className="grid grid-cols-1 gap-3"
      data-testid={`software-template-edit-form-${template.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !version.trim() || !yamlContent.trim()) return;
        onSubmit({
          name: name.trim(),
          version: version.trim(),
          description: optionalText(description),
          yamlContent,
          tags: parseTagInput(tags),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_140px]">
        <FormField id={`${id}-name`} label={t("software.manage.templateName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField id={`${id}-version`} label={t("software.manage.version")}>
          {(field) => (
            <Input {...field} value={version} onChange={(e) => setVersion(e.target.value)} />
          )}
        </FormField>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.description")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-tags`} label={t("software.manage.tags")}>
        {(field) => <Input {...field} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </FormField>
      <FormField id={`${id}-yamlContent`} label={t("software.detail.yamlSource")}>
        {(field) => (
          <Textarea
            {...field}
            value={yamlContent}
            onChange={(e) => setYamlContent(e.target.value)}
            placeholder={t("software.manage.yamlPlaceholder")}
            className="min-h-64 font-mono text-xs"
          />
        )}
      </FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          <Undo2 />
          {t("software.manage.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          <Save />
          {t("software.manage.publishTemplateVersion")}
        </Button>
      </div>
    </form>
  );
}

export function suggestNextTemplateVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.trim());
  if (!match) return "";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger) || patch >= Number.MAX_SAFE_INTEGER) {
    return "";
  }
  return `${major}.${minor}.${patch + 1}`;
}

function UsecasePackagesPanel({
  canManage,
  catalog,
  catalogSearch,
  catalogSource,
  favorites,
  hasFilter,
  page,
  hasNext,
  setCatalogPage,
  setCatalogSearch,
  setCatalogSource,
  setPage,
  toggleFavorite,
  total,
  updateUsecase,
  updateUsecasePending,
  usecases,
}: {
  canManage: boolean;
  catalog: SpackCatalog | null;
  catalogSearch: string;
  catalogSource: SpackCatalogSourceFilter;
  favorites: Set<string>;
  hasFilter: boolean;
  page: number;
  hasNext: boolean;
  setCatalogPage: (value: number) => void;
  setCatalogSearch: (value: string) => void;
  setCatalogSource: (value: SpackCatalogSourceFilter) => void;
  setPage: (value: number) => void;
  toggleFavorite: (key: string) => void;
  total: number;
  updateUsecase: (id: string, payload: UsecasePackageUpdate, onSuccess: () => void) => void;
  updateUsecasePending: boolean;
  usecases: UsecasePackage[];
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingUsecase = usecases.find((item) => item.id === editingId) ?? null;
  return (
    <div className="grid gap-4">
      <div className="grid min-w-0 content-start gap-3" data-testid="software-usecase-list">
        {usecases.length === 0 ? (
          hasFilter ? (
            <SmallEmpty icon={<FlaskConical />} text={t("software.noMatches")} />
          ) : (
            <CatalogEmptyState
              actionLabel={t("software.usecaseEmptyAction")}
              actionTo="/software/usecases/new"
              description={t("software.usecaseEmptyDescription")}
              icon={<FlaskConical />}
              showAction={canManage}
              testId="software-usecase-empty"
              title={t("software.usecaseEmptyTitle")}
            />
          )
        ) : (
          <>
            <ServerPagination
              hasNext={hasNext}
              page={page}
              setPage={setPage}
              shown={usecases.length}
              total={total}
            />
            <SoftwareCardGrid>
              {usecases.map((pkg) => {
                const key = favoriteKey("usecase", pkg.id);
                return (
                  <UsecaseCard
                    key={pkg.id}
                    favorite={favorites.has(key)}
                    onEdit={canManage ? () => setEditingId(pkg.id) : undefined}
                    onToggleFavorite={() => toggleFavorite(key)}
                    pkg={pkg}
                  />
                );
              })}
            </SoftwareCardGrid>
            <ServerPagination
              hasNext={hasNext}
              page={page}
              setPage={setPage}
              shown={usecases.length}
              total={total}
            />
          </>
        )}
      </div>
      {canManage && editingUsecase ? (
        <Sheet
          open={true}
          onOpenChange={(open) => !open && !updateUsecasePending && setEditingId(null)}
        >
          <SheetContent
            width="max-w-2xl"
            data-testid="software-usecase-edit-sheet"
            dismissible={!updateUsecasePending}
          >
            <SheetHeader>
              <SheetTitle>{t("software.manage.publishUsecaseVersion")}</SheetTitle>
              <SheetDescription>{editingUsecase.name}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <UsecasePackageEditForm
                catalog={catalog}
                catalogSearch={catalogSearch}
                catalogSource={catalogSource}
                isPending={updateUsecasePending}
                pkg={editingUsecase}
                onCancel={() => setEditingId(null)}
                onSubmit={(payload) => {
                  updateUsecase(editingUsecase.id, payload, () => setEditingId(null));
                }}
                setCatalogPage={setCatalogPage}
                setCatalogSearch={setCatalogSearch}
                setCatalogSource={setCatalogSource}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function SpackSoftwarePanel({
  activeOrganizationId,
  canManage,
  canManagePlatform,
  canRequestAccess,
  canSubmitAssets,
  favorites,
  removeCatalogPackage,
  removeCatalogPackagePending,
  requestAccess,
  submitAsset,
  spackCatalog,
  spackCatalogPackages,
  setSpackCatalogPage,
  toggleFavorite,
  updateCatalogPackage,
  updateCatalogPackagePending,
}: {
  activeOrganizationId: string | null;
  canManage: boolean;
  canManagePlatform: boolean;
  canRequestAccess: boolean;
  canSubmitAssets: boolean;
  favorites: Set<string>;
  removeCatalogPackage: (id: string, onSuccess: () => void) => void;
  removeCatalogPackagePending: boolean;
  requestAccess: (asset: SoftwareAssetSummary) => void;
  submitAsset: (assetId: string) => void;
  spackCatalog: SpackCatalog | null;
  spackCatalogPackages: SpackCatalogPackage[];
  setSpackCatalogPage: (value: number) => void;
  toggleFavorite: (key: string) => void;
  updateCatalogPackage: (
    id: string,
    payload: SpackCatalogPackageUpdate,
    onSuccess: () => void,
  ) => void;
  updateCatalogPackagePending: boolean;
}) {
  const { t } = useTranslation();
  if (spackCatalog && spackCatalog.packageCount === 0 && spackCatalog.customCount === 0) {
    return (
      <CatalogEmptyState
        actionLabel={t("software.spackEmptyAction")}
        actionTo="/software/spack/new"
        description={t("software.spackEmptyDescription")}
        icon={<Boxes />}
        showAction={canManage}
        testId="software-spack-empty"
        title={t("software.spackEmptyTitle")}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <SpackCatalogOptions catalog={spackCatalog} />
      <SpackCatalogSummary catalog={spackCatalog} />
      <SpackCatalogPackageList
        canManage={canManage}
        canManagePlatform={canManagePlatform}
        activeOrganizationId={activeOrganizationId}
        canRequestAccess={canRequestAccess}
        canSubmitAssets={canSubmitAssets}
        catalog={spackCatalog}
        favorites={favorites}
        packages={spackCatalogPackages}
        removePackage={removeCatalogPackage}
        removePackagePending={removeCatalogPackagePending}
        requestAccess={requestAccess}
        setPage={setSpackCatalogPage}
        submitAsset={submitAsset}
        toggleFavorite={toggleFavorite}
        updatePackage={updateCatalogPackage}
        updatePackagePending={updateCatalogPackagePending}
      />
    </div>
  );
}

function SpackCatalogSummary({ catalog }: { catalog: SpackCatalog | null }) {
  const { t } = useTranslation();
  if (!catalog) return null;
  return (
    <div data-testid="software-spack-catalog-summary">
      <div className=" border-border p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{t("software.manage.officialCatalog")}</div>
        <div className="mt-1 leading-5">
          {t("software.manage.catalogStats", {
            count: catalog.packageCount,
            custom: catalog.customCount,
            repo: catalog.sourceRepository,
            ref: catalog.sourceRef,
            upstream: catalog.upstreamCount,
            date: catalog.generatedAt,
          })}
        </div>
      </div>
    </div>
  );
}

function SpackCatalogPackageList({
  activeOrganizationId,
  canManage,
  canManagePlatform,
  canRequestAccess,
  canSubmitAssets,
  catalog,
  favorites,
  packages,
  removePackage,
  removePackagePending,
  requestAccess,
  setPage,
  submitAsset,
  toggleFavorite,
  updatePackage,
  updatePackagePending,
}: {
  activeOrganizationId: string | null;
  canManage: boolean;
  canManagePlatform: boolean;
  canRequestAccess: boolean;
  canSubmitAssets: boolean;
  catalog: SpackCatalog | null;
  favorites: Set<string>;
  packages: SpackCatalogPackage[];
  removePackage: (id: string, onSuccess: () => void) => void;
  removePackagePending: boolean;
  requestAccess: (asset: SoftwareAssetSummary) => void;
  setPage: (value: number) => void;
  submitAsset: (assetId: string) => void;
  toggleFavorite: (key: string) => void;
  updatePackage: (id: string, payload: SpackCatalogPackageUpdate, onSuccess: () => void) => void;
  updatePackagePending: boolean;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const editingPackage = catalog?.packages.find((pkg) => pkg.id === editingId) ?? null;
  const deletingPackage = catalog?.packages.find((pkg) => pkg.id === deletingId) ?? null;
  if (!catalog) return null;
  return (
    <div className="grid min-w-0 content-start gap-3" data-testid="software-spack-list">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t("software.manage.catalogResults")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("software.manage.catalogResultCount", {
              shown: packages.length,
              total: catalog.totalCount,
            })}
          </div>
        </div>
        <PaginationControls
          previous={{
            disabled: !catalog.hasPrevious,
            onClick: () => setPage(Math.max(1, catalog.page - 1)),
            "data-testid": "software-spack-catalog-prev",
            children: (
              <>
                <ChevronLeft />
                {t("software.manage.previousPage")}
              </>
            ),
          }}
          next={{
            disabled: !catalog.hasNext,
            onClick: () => setPage(catalog.page + 1),
            "data-testid": "software-spack-catalog-next",
            children: (
              <>
                {t("software.manage.nextPage")}
                <ChevronRight />
              </>
            ),
          }}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("software.manage.catalogPageStatus", {
              page: catalog.page,
              total: catalog.totalPages,
            })}
          </span>
        </PaginationControls>
      </div>
      <SoftwareCardGrid className="gap-3" data-testid="software-spack-catalog-list">
        {packages.length === 0 ? (
          <span className="text-muted-foreground">{t("software.manage.catalogNoMatches")}</span>
        ) : (
          packages.map((pkg) => {
            const key = favoriteKey("spack", catalogPackageKey(pkg));
            const asset = pkg.asset ?? null;
            const canManagePackage =
              pkg.source === "official"
                ? canManagePlatform
                : pkg.source === "vendor" &&
                  (canManagePlatform || (canManage && pkg.ownerOrgId === activeOrganizationId));
            return (
              <div
                key={`${pkg.source}:${pkg.id ?? pkg.name}`}
                className={`grid min-w-0 content-start gap-2 p-3 ${clickableCardClass}`}
                data-testid={`software-spack-catalog-package-${pkg.source}-${pkg.name}`}
              >
                <Link
                  to="/software/spack/$source/$name"
                  params={{ name: pkg.name, source: pkg.source }}
                  className={cardSurfaceLinkClass}
                  aria-label={`${t("software.manage.view")}: ${pkg.name}`}
                  data-testid={`software-spack-card-surface-${pkg.source}-${pkg.name}`}
                />
                <div className={`min-w-0 ${cardContentLayerClass}`}>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <div className="min-w-0">
                      <Link
                        to="/software/spack/$source/$name"
                        params={{ name: pkg.name, source: pkg.source }}
                        className={`block truncate font-mono text-sm font-semibold text-foreground hover:text-brand ${cardActionLayerClass}`}
                      >
                        {pkg.name}
                      </Link>
                      {pkg.ownerOrgId ? (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {t("software.manage.ownerOrg")}: {pkg.ownerOrgId}
                        </div>
                      ) : null}
                    </div>
                    <div className={`flex shrink-0 items-center gap-1.5 ${cardActionLayerClass}`}>
                      <FavoriteButton
                        active={favorites.has(key)}
                        onClick={() => toggleFavorite(key)}
                      />
                      <Badge variant={pkg.source === "upstream" ? "outline" : "brand"}>
                        {sourceLabel(t, pkg.source)}
                      </Badge>
                    </div>
                  </div>
                  {pkg.asset ? (
                    <div
                      className="mt-2 flex flex-wrap gap-1"
                      data-testid={`software-spack-asset-status-${pkg.source}-${pkg.name}`}
                    >
                      <AssetStatusBadges asset={pkg.asset} />
                    </div>
                  ) : null}
                  {pkg.description ? (
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                      {pkg.description}
                    </p>
                  ) : null}
                  <div className="mt-2 flex min-h-6 flex-wrap gap-1">
                    {pkg.metadata ? (
                      <>
                        <Badge variant="outline">
                          {t("software.manage.versionCount", {
                            count: pkg.metadata.versions.length,
                          })}
                        </Badge>
                        <Badge variant="outline">
                          {t("software.manage.variantCount", {
                            count: pkg.metadata.variants.length,
                          })}
                        </Badge>
                      </>
                    ) : null}
                    {pkg.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className={`kq-fill-row gap-1 border-border pt-2 ${cardActionLayerClass}`}>
                  <Button
                    asChild
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`software-view-catalog-package-${pkg.source}-${pkg.name}`}
                  >
                    <Link
                      to="/software/spack/$source/$name"
                      params={{ name: pkg.name, source: pkg.source }}
                    >
                      <Eye />
                      {t("software.manage.view")}
                    </Link>
                  </Button>
                  {asset ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canRequestAccess}
                      onClick={() => requestAccess(asset)}
                      data-testid={`software-request-catalog-package-${pkg.source}-${pkg.name}`}
                    >
                      <ShieldAlert />
                      {t("software.access.requestInstall")}
                    </Button>
                  ) : null}
                  {canManagePackage && pkg.id ? (
                    <>
                      {pkg.asset?.lifecycle === "draft" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!canSubmitAssets}
                          onClick={() => {
                            if (pkg.asset) submitAsset(pkg.asset.id);
                          }}
                          data-testid={`software-submit-catalog-package-${pkg.id}`}
                        >
                          <GitBranch />
                          {t("software.governance.submit")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingId(pkg.id ?? null)}
                        data-testid={`software-edit-catalog-package-${pkg.id}`}
                      >
                        <Edit3 />
                        {t("software.manage.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeletingId(pkg.id ?? null)}
                        data-testid={`software-delete-catalog-package-${pkg.id}`}
                      >
                        <Trash2 />
                        {t("software.manage.delete")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </SoftwareCardGrid>
      {editingPackage?.id ? (
        <Sheet
          open={true}
          onOpenChange={(open) => !open && !updatePackagePending && setEditingId(null)}
        >
          <SheetContent
            width="max-w-2xl"
            data-testid="software-spack-edit-sheet"
            dismissible={!updatePackagePending}
          >
            <SheetHeader>
              <SheetTitle>{t("software.manage.editSpack")}</SheetTitle>
              <SheetDescription>{editingPackage.name}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <SpackCatalogPackageEditForm
                pkg={editingPackage}
                isPending={updatePackagePending}
                onCancel={() => setEditingId(null)}
                onSubmit={(payload) => {
                  updatePackage(editingPackage.id ?? "", payload, () => setEditingId(null));
                }}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      ) : null}
      {deletingPackage?.id ? (
        <Dialog
          open={true}
          onOpenChange={(open) => !open && !removePackagePending && setDeletingId(null)}
        >
          <DialogContent
            data-testid="software-delete-catalog-package-dialog"
            dismissible={!removePackagePending}
          >
            <DialogHeader>
              <DialogTitle>{t("software.manage.deleteCatalogPackageTitle")}</DialogTitle>
              <DialogDescription>
                {t("software.manage.deleteCatalogPackageDescription", {
                  name: deletingPackage.name,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                disabled={removePackagePending}
                onClick={() => setDeletingId(null)}
              >
                {t("software.manage.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={removePackagePending}
                onClick={() => removePackage(deletingPackage.id ?? "", () => setDeletingId(null))}
                data-testid="software-delete-catalog-package-confirm"
              >
                {removePackagePending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {t("software.manage.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function SpackCatalogOptions({ catalog }: { catalog: SpackCatalog | null }) {
  if (!catalog) return null;
  return (
    <datalist id="software-spack-package-catalog">
      {catalog.packages.map((pkg) => (
        <option key={`${pkg.source}:${pkg.id ?? pkg.name}`} value={pkg.name} />
      ))}
    </datalist>
  );
}

function SpackCatalogPackageEditForm({
  isPending,
  onCancel,
  onSubmit,
  pkg,
}: {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (payload: SpackCatalogPackageUpdate) => void;
  pkg: SpackCatalogPackage;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(pkg.name);
  const [source, setSource] = useState<SpackCatalogPackageCreate["source"]>(
    pkg.source === "vendor" ? "vendor" : "official",
  );
  const [description, setDescription] = useState(pkg.description ?? "");
  const [tags, setTags] = useState(pkg.tags.join(","));
  return (
    <form
      className="grid gap-3"
      data-testid={`software-spack-catalog-package-edit-form-${pkg.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit({
          name: name.trim(),
          source,
          description: optionalText(description),
          tags: parseTagInput(tags),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_150px]">
        <FormField id={`${id}-name`} label={t("software.manage.catalogPackageName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <label htmlFor={`${id}-source`} className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("software.manage.catalogPackageSource")}</span>
          <NativeSelect
            id={`${id}-source`}
            value={source}
            onChange={(e) => setSource(e.target.value as SpackCatalogPackageCreate["source"])}
            aria-label={t("software.manage.catalogPackageSource")}
          >
            <option value="official">{sourceLabel(t, "official")}</option>
            <option value="vendor">{sourceLabel(t, "vendor")}</option>
          </NativeSelect>
        </label>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.catalogPackageDescription")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-tags`} label={t("software.manage.catalogPackageTags")}>
        {(field) => <Input {...field} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          <Undo2 />
          {t("software.manage.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          <Save />
          {t("software.manage.save")}
        </Button>
      </div>
    </form>
  );
}

function UsecaseCard({
  favorite,
  onEdit,
  onToggleFavorite,
  pkg,
}: {
  favorite: boolean;
  onEdit?: () => void;
  onToggleFavorite: () => void;
  pkg: UsecasePackage;
}) {
  const { t } = useTranslation();
  const softwareLabel =
    pkg.spec.software.kind === "Spack"
      ? [pkg.spec.software.name, ...pkg.spec.software.argumentList].join(" ")
      : pkg.spec.software.kind === "Singularity"
        ? `${pkg.spec.software.image}:${pkg.spec.software.tag}`
        : "Bare";
  const moduleName = pkg.spec.software.kind === "Spack" ? pkg.spec.software.moduleName : null;
  const compiler = pkg.spec.software.kind === "Spack" ? pkg.spec.software.compiler : null;
  const variantRef = pkg.spec.software.kind === "Spack" ? pkg.spec.software.variantRef : null;
  return (
    <article
      className={`flex min-w-0 flex-col gap-2 p-3 ${clickableCardClass}`}
      data-testid={`software-usecase-card-${pkg.id}`}
    >
      <Link
        to="/software/usecases/$usecaseId"
        params={{ usecaseId: pkg.id }}
        className={cardSurfaceLinkClass}
        aria-label={`${t("software.manage.view")}: ${pkg.name}`}
        data-testid={`software-usecase-card-surface-${pkg.id}`}
      />
      <div className={`flex items-start justify-between gap-3 ${cardContentLayerClass}`}>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{pkg.name}</div>
        </div>
        <div className={`flex shrink-0 items-center gap-1 ${cardActionLayerClass}`}>
          <FavoriteButton active={favorite} onClick={onToggleFavorite} />
          <Badge variant="outline">v{pkg.version}</Badge>
        </div>
      </div>
      {pkg.description && (
        <p className={`line-clamp-2 text-xs text-muted-foreground ${cardContentLayerClass}`}>
          {pkg.description}
        </p>
      )}
      <div className={`grid grid-cols-2 gap-2 text-xs ${cardContentLayerClass}`}>
        <InfoTile label={t("software.manage.commandFile")} value={pkg.spec.usecase.commandFile} />
        <InfoTile label={t("software.manage.boundSoftware")} value={softwareLabel} />
        {compiler && <InfoTile label={t("software.manage.compiler")} value={compiler} />}
        {moduleName && <InfoTile label={t("software.manage.module")} value={moduleName} />}
        {variantRef && <InfoTile label={t("software.manage.variantRef")} value={variantRef} />}
      </div>
      <div className={`mt-auto flex flex-wrap gap-1.5 pt-1 ${cardActionLayerClass}`}>
        <Button asChild variant="outline" size="sm" data-testid={`software-view-usecase-${pkg.id}`}>
          <Link to="/software/usecases/$usecaseId" params={{ usecaseId: pkg.id }}>
            <Eye />
            {t("software.manage.view")}
          </Link>
        </Button>
        {onEdit ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit3 />
            {t("software.manage.edit")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function UsecasePackageEditForm({
  catalog,
  catalogSearch,
  catalogSource,
  isPending,
  onCancel,
  onSubmit,
  pkg,
  setCatalogPage,
  setCatalogSearch,
  setCatalogSource,
}: {
  catalog: SpackCatalog | null;
  catalogSearch: string;
  catalogSource: SpackCatalogSourceFilter;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (payload: UsecasePackageUpdate) => void;
  pkg: UsecasePackage;
  setCatalogPage: (value: number) => void;
  setCatalogSearch: (value: string) => void;
  setCatalogSource: (value: SpackCatalogSourceFilter) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const packages = catalog?.packages ?? [];
  const currentSoftware = pkg.spec.software;
  const initialPackage =
    currentSoftware.kind === "Spack" ? findCatalogPackage(packages, currentSoftware) : null;
  const [name, setName] = useState(pkg.name);
  const [version, setVersion] = useState(() => suggestNextTemplateVersion(pkg.version));
  const [description, setDescription] = useState(pkg.description ?? "");
  const [commandFile, setCommandFile] = useState(pkg.spec.usecase.commandFile);
  const [inputDescriptor, setInputDescriptor] = useState(pkg.spec.arguments[0]?.descriptor ?? "");
  const [argumentFormat, setArgumentFormat] = useState(pkg.spec.arguments[0]?.valueFormat ?? "{}");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<SpackCatalogPackage | null>(
    initialPackage,
  );
  const [softwareVersion, setSoftwareVersion] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.version ?? "") : "",
  );
  const [compiler, setCompiler] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.compiler ?? "") : "",
  );
  const [moduleName, setModuleName] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.moduleName ?? "") : "",
  );
  const [variants, setVariants] = useState(
    currentSoftware.kind === "Spack" ? currentSoftware.argumentList.join(" ") : "",
  );
  return (
    <form
      className="grid min-w-0 grid-cols-1 content-start gap-3"
      data-testid={`software-usecase-edit-form-${pkg.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !version.trim() || !commandFile.trim() || !selectedPackage) return;
        onSubmit({
          name: name.trim(),
          version: version.trim(),
          description: optionalText(description),
          spec: makeUsecaseSpec(
            commandFile.trim(),
            inputDescriptor.trim(),
            argumentFormat,
            selectedPackage,
            {
              compiler,
              moduleName,
              variants,
              version: softwareVersion,
            },
          ),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_120px]">
        <FormField id={`${id}-name`} label={t("software.manage.usecaseName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField id={`${id}-version`} label={t("software.manage.version")}>
          {(field) => (
            <Input {...field} value={version} onChange={(e) => setVersion(e.target.value)} />
          )}
        </FormField>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.description")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-commandFile`} label={t("software.manage.commandFile")}>
        {(field) => (
          <Input {...field} value={commandFile} onChange={(e) => setCommandFile(e.target.value)} />
        )}
      </FormField>
      <CatalogPackagePickerField selected={selectedPackage} onOpen={() => setPickerOpen(true)} />
      <SpackCatalogPickerDialog
        catalog={catalog}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={setSelectedPackage}
        search={catalogSearch}
        selected={selectedPackage}
        setPage={setCatalogPage}
        setSearch={setCatalogSearch}
        setSource={setCatalogSource}
        source={catalogSource}
      />
      <SpackSpecPickerField
        compiler={compiler}
        metadata={selectedPackage?.metadata}
        moduleName={moduleName}
        onOpen={() => setSpecOpen(true)}
        packageName={selectedPackage?.metadata?.name ?? selectedPackage?.name ?? null}
        defaultSpec={selectedPackage?.defaultSpec}
        softwareVersion={softwareVersion}
        variants={variants}
      />
      <SpackSpecConfigSheet
        compiler={compiler}
        metadata={selectedPackage?.metadata}
        moduleName={moduleName}
        onCompilerChange={setCompiler}
        onModuleNameChange={setModuleName}
        onOpenChange={setSpecOpen}
        onSoftwareVersionChange={setSoftwareVersion}
        onVariantsChange={setVariants}
        open={specOpen}
        packageName={selectedPackage?.metadata?.name ?? selectedPackage?.name ?? null}
        defaultSpec={selectedPackage?.defaultSpec}
        softwareVersion={softwareVersion}
        variants={variants}
      />
      <div className="grid gap-2 md:grid-cols-2">
        <FormField id={`${id}-inputDescriptor`} label={t("software.manage.inputDescriptor")}>
          {(field) => (
            <Input
              {...field}
              value={inputDescriptor}
              onChange={(e) => setInputDescriptor(e.target.value)}
            />
          )}
        </FormField>
        <FormField id={`${id}-argumentFormat`} label={t("software.manage.argumentFormat")}>
          {(field) => (
            <Input
              {...field}
              value={argumentFormat}
              onChange={(e) => setArgumentFormat(e.target.value)}
            />
          )}
        </FormField>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          <Undo2 />
          {t("software.manage.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!selectedPackage || isPending}>
          <Save />
          {t("software.manage.publishUsecaseVersion")}
        </Button>
      </div>
    </form>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs" title={value}>
        {value}
      </div>
    </div>
  );
}

function spackPackageNameFromSpecName(name: string): string {
  return name.split(/[ @%]/)[0] ?? name;
}

function findCatalogPackage(
  packages: SpackCatalogPackage[],
  software: { name: string; variantRef?: string },
): SpackCatalogPackage | null {
  const byRef = software.variantRef
    ? packages.find((item) => catalogPackageKey(item) === software.variantRef)
    : undefined;
  if (byRef) return byRef;
  const packageName = spackPackageNameFromSpecName(software.name);
  const byName = packages.find((item) => item.name === packageName);
  if (byName) return byName;
  if (!packageName) return null;
  const refParts = software.variantRef?.split(":") ?? [];
  const source =
    refParts[0] === "catalog" &&
    (refParts[1] === "upstream" || refParts[1] === "official" || refParts[1] === "vendor")
      ? refParts[1]
      : "official";
  return {
    ...(software.variantRef && !software.variantRef.startsWith("catalog:")
      ? { id: software.variantRef }
      : {}),
    name: packageName,
    source,
    tags: [],
  };
}

function SoftwareEmptyState({ canCreate }: { canCreate: boolean }) {
  const { t } = useTranslation();
  return (
    <CatalogEmptyState
      actionLabel={t("software.emptyAction")}
      actionTo="/software/workflow-templates/new"
      description={t("software.empty")}
      icon={<Workflow />}
      showAction={canCreate}
      testId="software-empty"
      title={t("software.emptyTitle")}
    />
  );
}
