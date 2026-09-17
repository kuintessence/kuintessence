import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, ChevronLeft, FlaskConical, PackagePlus, ShieldCheck, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { getAuthState } from "../../lib/auth";
import {
  createSpackCatalogPackage,
  createUsecasePackage,
  createWorkflowTemplate,
  listSpackCatalog,
  type SpackCatalogSourceFilter,
  type UsecasePackageCreate,
  type WorkflowTemplateCreate,
} from "../../lib/software-client";
import { type SoftwareSection, softwareCatalogDestination } from "../../lib/software-navigation";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import {
  SPACK_CATALOG_PAGE_SIZE,
  SpackCatalogPackageForm,
  UsecasePackageForm,
  WorkflowTemplateForm,
} from "./SoftwarePage";

function CreatePageShell({
  children,
  description,
  icon,
  section,
  summary,
  title,
}: {
  children: ReactNode;
  description: string;
  icon: ReactNode;
  section: SoftwareSection;
  summary: {
    artifact: string;
    checks: string;
    destination: string;
  };
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <PageShell data-testid="software-create-page">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="[&_svg]:h-5 [&_svg]:w-5 [&_svg]:text-muted-foreground">{icon}</span>
            {title}
          </span>
        }
        subtitle={description}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link {...softwareCatalogDestination(section)}>
              <ChevronLeft />
              {t("software.manage.backToSoftware")}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">{children}</div>
        <aside className="grid content-start gap-3">
          <CreateSummaryTile
            icon={<PackagePlus />}
            label={t("software.create.artifact")}
            value={summary.artifact}
          />
          <CreateSummaryTile
            icon={<Boxes />}
            label={t("software.create.destination")}
            value={summary.destination}
          />
          <CreateSummaryTile
            icon={<ShieldCheck />}
            label={t("software.create.checks")}
            value={summary.checks}
          />
        </aside>
      </div>
    </PageShell>
  );
}

function CreateSummaryTile({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

export function SoftwareWorkflowTemplateCreatePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createTemplate = useMutation({
    mutationFn: createWorkflowTemplate,
    onSuccess: () => {
      toast.success(t("software.manage.templateCreated"));
      void queryClient.invalidateQueries({ queryKey: ["software-templates"] });
      void navigate(softwareCatalogDestination("templates"));
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.createFailed"))),
  });
  return (
    <CreatePageShell
      description={t("software.manage.createTemplatePageDescription")}
      icon={<Workflow />}
      section="templates"
      summary={{
        artifact: t("software.create.workflowArtifact"),
        checks: t("software.create.workflowChecks"),
        destination: t("software.create.registry"),
      }}
      title={t("software.manage.createTemplatePage")}
    >
      <WorkflowTemplateForm
        isPending={createTemplate.isPending}
        onSubmit={(payload: WorkflowTemplateCreate) => createTemplate.mutate(payload)}
      />
    </CreatePageShell>
  );
}

export function SoftwareUsecaseCreatePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeOrganizationId = useActiveOrganizationId();
  const [spackCatalogSearch, setSpackCatalogSearch] = useState("");
  const [spackCatalogSource, setSpackCatalogSource] = useState<SpackCatalogSourceFilter>("all");
  const [spackCatalogPage, setSpackCatalogPage] = useState(1);
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
  const spackCatalogError = spackCatalogQ.error instanceof Error ? spackCatalogQ.error : null;
  const updateSpackCatalogSearch = (value: string) => {
    setSpackCatalogSearch(value);
    setSpackCatalogPage(1);
  };
  const updateSpackCatalogSource = (value: SpackCatalogSourceFilter) => {
    setSpackCatalogSource(value);
    setSpackCatalogPage(1);
  };
  const createUsecase = useMutation({
    mutationFn: (payload: UsecasePackageCreate) =>
      createUsecasePackage(payload, activeOrganizationId ?? undefined),
    onSuccess: () => {
      toast.success(t("software.manage.usecaseCreated"));
      void queryClient.invalidateQueries({ queryKey: ["software-usecases"] });
      void navigate(softwareCatalogDestination("usecases"));
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.createFailed"))),
  });
  return (
    <CreatePageShell
      description={t("software.manage.createUsecasePageDescription")}
      icon={<FlaskConical />}
      section="usecases"
      summary={{
        artifact: t("software.create.usecaseArtifact"),
        checks: t("software.create.usecaseChecks"),
        destination: t("software.create.registry"),
      }}
      title={t("software.manage.createUsecasePage")}
    >
      <UsecasePackageForm
        catalog={spackCatalogError ? null : (spackCatalogQ.data ?? null)}
        catalogError={spackCatalogError}
        catalogSearch={spackCatalogSearch}
        catalogSource={spackCatalogSource}
        isPending={createUsecase.isPending}
        requiresActiveOrganization={getAuthState().role === "org_admin" && !activeOrganizationId}
        onSubmit={(payload: UsecasePackageCreate) => createUsecase.mutate(payload)}
        setCatalogPage={setSpackCatalogPage}
        setCatalogSearch={updateSpackCatalogSearch}
        setCatalogSource={updateSpackCatalogSource}
      />
    </CreatePageShell>
  );
}

export function SoftwareSpackCatalogCreatePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeOrganizationId = useActiveOrganizationId();
  const createPackage = useMutation({
    mutationFn: (payload: Parameters<typeof createSpackCatalogPackage>[0]) =>
      createSpackCatalogPackage(
        payload,
        payload.source === "vendor" ? (activeOrganizationId ?? undefined) : undefined,
      ),
    onSuccess: () => {
      toast.success(t("software.manage.catalogPackageCreated"));
      void queryClient.invalidateQueries({ queryKey: ["software-spack-catalog"] });
      void navigate(softwareCatalogDestination("spack"));
    },
    onError: (err) => toast.error(toUserFacingError(err, t("software.manage.createFailed"))),
  });
  return (
    <CreatePageShell
      description={t("software.manage.createCatalogPackagePageDescription")}
      icon={<PackagePlus />}
      section="spack"
      summary={{
        artifact: t("software.create.catalogArtifact"),
        checks: t("software.create.catalogChecks"),
        destination: t("software.create.localMirror"),
      }}
      title={t("software.manage.createCatalogPackagePage")}
    >
      <SpackCatalogPackageForm
        isPending={createPackage.isPending}
        requiresActiveOrganizationForVendor={
          getAuthState().role === "org_admin" && !activeOrganizationId
        }
        onSubmit={(payload) => createPackage.mutate(payload)}
      />
    </CreatePageShell>
  );
}
