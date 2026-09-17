import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Boxes,
  Braces,
  Check,
  ChevronLeft,
  Clipboard,
  ExternalLink,
  FlaskConical,
  GitBranch,
  PackageCheck,
  Puzzle,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveSoftwareAvailability } from "../../lib/api-client";
import { softwareAvailabilityReason } from "../../lib/software-availability-reason";
import {
  getUsecasePackage,
  getWorkflowTemplate,
  type LicensePolicy,
  listSpackCatalog,
  type SpackCatalogPackage,
  type SpackCatalogSource,
  type SpackPackageMetadata,
  type SpackSoftwareSpec,
  type UsecasePackage,
  type WorkflowTemplate,
} from "../../lib/software-client";
import { type SoftwareSection, softwareCatalogDestination } from "../../lib/software-navigation";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { parseWorkflowYaml, summarize } from "../../lib/workflow-parser";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";

interface DetailShellProps {
  children: React.ReactNode;
  description?: string | null;
  icon: React.ReactNode;
  section: SoftwareSection;
  title: string;
}

function DetailShell({ children, description, icon, section, title }: DetailShellProps) {
  const { t } = useTranslation();
  return (
    <PageShell data-testid="software-detail-page">
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="[&_svg]:h-5 [&_svg]:w-5 [&_svg]:text-muted-foreground">{icon}</span>
            <span className="break-words">{title}</span>
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
      {children}
    </PageShell>
  );
}

function DetailInfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}

function DetailMetricTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 truncate font-mono text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function DetailEmpty({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function LicensePolicyPanel({ policy }: { policy?: LicensePolicy }) {
  const { t } = useTranslation();
  if (!policy) {
    return (
      <DetailSection title={t("software.detail.license")}>
        <DetailEmpty text={t("software.detail.licenseUnavailable")} />
      </DetailSection>
    );
  }
  const restrictions = [
    policy.acceptanceRequired ? t("software.detail.acceptanceRequired") : null,
    policy.providerEntitlements?.length ? t("software.detail.providerEntitlementRequired") : null,
    policy.consumerEntitlements?.length ? t("software.detail.consumerEntitlementRequired") : null,
    policy.redistribution
      ? `${t("software.detail.redistribution")}: ${policy.redistribution}`
      : null,
    policy.autoInstall ? `${t("software.detail.autoInstall")}: ${policy.autoInstall}` : null,
  ].filter((item): item is string => item !== null);
  return (
    <DetailSection title={t("software.detail.license")}>
      <div className="grid gap-3 rounded-md border border-border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={policy.classification === "proprietary" ? "failed" : "outline"}>
              {policy.classification}
            </Badge>
            {policy.identifiers.map((identifier) => (
              <Badge key={`${identifier.kind}:${identifier.value}`} variant="outline">
                {identifier.kind.toUpperCase()}: {identifier.value}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("software.detail.licenseInheritance")}</p>
          {policy.provenance ? (
            <p className="break-all text-xs text-muted-foreground">
              {t("software.detail.provenance")}: {policy.provenance.source} /{" "}
              {policy.provenance.reference}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          {restrictions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {restrictions.map((restriction) => (
                <Badge key={restriction} variant="outline">
                  {restriction}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {policy.termsUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={policy.termsUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {t("software.detail.terms")}
                </a>
              </Button>
            ) : null}
            {policy.noticeUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={policy.noticeUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {t("software.detail.notice")}
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </DetailSection>
  );
}

function DetailError({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
      data-testid="software-detail-error"
    >
      {toUserFacingError(error, t("software.unreachable"))}
    </div>
  );
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

interface TemplateGraphNodeData extends Record<string, unknown> {
  kind: string;
  label: string;
}

const TEMPLATE_NODE_WIDTH = 220;
const TEMPLATE_NODE_HEIGHT = 68;

function TemplateGraphNode({ data }: { data: TemplateGraphNodeData }) {
  return (
    <div
      className="grid gap-1 rounded-md border border-border bg-card p-2 shadow-sm"
      style={{ width: TEMPLATE_NODE_WIDTH, height: TEMPLATE_NODE_HEIGHT }}
    >
      <div className="truncate text-xs font-medium text-foreground">{data.label}</div>
      <div className="truncate font-mono text-[11px] text-muted-foreground">{data.kind}</div>
    </div>
  );
}

const TEMPLATE_NODE_TYPES = { template: TemplateGraphNode };

function layoutTemplateGraph(nodes: { id: string }[], edges: { source: string; target: string }[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", marginx: 24, marginy: 24, nodesep: 34, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    g.setNode(node.id, { width: TEMPLATE_NODE_WIDTH, height: TEMPLATE_NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const laid = g.node(node.id);
    positions.set(node.id, {
      x: (laid?.x ?? 0) - TEMPLATE_NODE_WIDTH / 2,
      y: (laid?.y ?? 0) - TEMPLATE_NODE_HEIGHT / 2,
    });
  }
  return positions;
}

function WorkflowTemplateFlow({ template }: { template: WorkflowTemplate }) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseWorkflowYaml(template.yamlContent), [template.yamlContent]);
  const graph = useMemo(() => {
    if (!parsed.ok) return null;
    const nodes = parsed.workflow.spec.nodeDrafts.map((node) => ({
      id: node.id,
      kind: node.type,
      name: node.name,
    }));
    const edges = parsed.workflow.spec.nodeRelations.map((edge, index) => ({
      id: `${edge.fromId}->${edge.toId}-${index}`,
      source: edge.fromId,
      target: edge.toId,
    }));
    const positions = layoutTemplateGraph(nodes, edges);
    return {
      edges,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: "template",
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { kind: node.kind, label: node.name },
      })),
    };
  }, [parsed]);

  if (!parsed.ok || !graph) {
    return <DetailEmpty text={parsed.ok ? t("software.detail.noGraph") : parsed.message} />;
  }

  return (
    <div
      className="h-[520px] overflow-hidden rounded-md border border-border bg-background"
      data-testid="software-template-flow"
    >
      <ReactFlow
        nodes={graph.nodes satisfies Node<TemplateGraphNodeData>[]}
        edges={graph.edges satisfies Edge[]}
        nodeTypes={TEMPLATE_NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function SoftwareWorkflowTemplateDetailPage({ templateId }: { templateId: string }) {
  const { t } = useTranslation();
  const templateQ = useQuery({
    queryKey: ["software-template", templateId],
    queryFn: () => getWorkflowTemplate(templateId),
    retry: false,
  });
  const template = templateQ.data ?? null;
  const templateSummary = useMemo(() => {
    if (!template) return null;
    const parsed = parseWorkflowYaml(template.yamlContent);
    if (!parsed.ok) {
      return {
        edgeCount: 0,
        isValid: false,
        nodeCount: 0,
        nodeTypes: [] as string[],
      };
    }
    const summary = summarize(parsed.workflow);
    return { ...summary, isValid: true };
  }, [template]);
  return (
    <DetailShell
      description={template?.description}
      icon={<Workflow />}
      section="templates"
      title={template?.name ?? t("software.detail.workflowTemplate")}
    >
      {templateQ.error instanceof Error ? (
        <DetailError error={templateQ.error} />
      ) : !template && templateQ.isLoading ? (
        <DetailEmpty text={t("common.loading")} />
      ) : !template ? (
        <DetailEmpty text={t("software.detail.notFound")} />
      ) : (
        <div className="grid gap-5">
          <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="min-w-0 rounded-md border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={templateSummary?.isValid ? "succeeded" : "failed"}>
                  {templateSummary?.isValid
                    ? t("software.detail.validWorkflow")
                    : t("software.detail.invalidWorkflow")}
                </Badge>
                <Badge variant="outline">v{template.version}</Badge>
                {template.tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <DetailInfoTile label="ID" value={template.id} />
                <DetailInfoTile
                  label={t("software.detail.createdAt")}
                  value={formatCreatedAt(template.createdAt)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DetailMetricTile
                icon={<Workflow />}
                label={t("software.detail.nodes")}
                value={templateSummary?.nodeCount ?? 0}
              />
              <DetailMetricTile
                icon={<GitBranch />}
                label={t("software.detail.edges")}
                value={templateSummary?.edgeCount ?? 0}
              />
              <DetailMetricTile
                icon={<Braces />}
                label={t("software.detail.nodeTypes")}
                value={templateSummary?.nodeTypes.length ?? 0}
              />
              <DetailMetricTile
                icon={<Check />}
                label={t("software.detail.validation")}
                value={
                  templateSummary?.isValid
                    ? t("software.detail.valid")
                    : t("software.detail.invalid")
                }
              />
            </div>
          </section>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <DetailSection title={t("software.detail.renderedGraph")}>
              <WorkflowTemplateFlow template={template} />
            </DetailSection>
            <DetailSection title={t("software.detail.yamlSource")}>
              <pre className="max-h-[520px] overflow-auto rounded-md border border-border bg-card p-3 text-xs">
                {template.yamlContent}
              </pre>
            </DetailSection>
          </div>
        </div>
      )}
    </DetailShell>
  );
}

function softwareSummary(pkg: UsecasePackage): string {
  const software = pkg.spec.software;
  if (software.kind === "Spack") {
    return [software.name, ...software.argumentList].filter(Boolean).join(" ");
  }
  if (software.kind === "Singularity") return `${software.image}:${software.tag}`;
  return "Bare";
}

function countUsecaseFiles(pkg: UsecasePackage): number {
  return pkg.spec.filesomeInputs.length + (pkg.spec.filesomeOutputs ?? []).length;
}

function parseCatalogVariantRef(spack: SpackSoftwareSpec | null): {
  name: string;
  source: SpackCatalogSource;
} | null {
  if (!spack) return null;
  const variantRef = spack.variantRef?.match(/^catalog:(upstream|official|vendor):(.+)$/);
  if (variantRef) {
    const source = parseCatalogSource(variantRef[1] ?? "upstream");
    const name = spackDependencyPackageName(variantRef[2] ?? "");
    return name ? { name, source } : null;
  }
  return null;
}

function UsecasePackageHero({
  pkg,
  spackTarget,
}: {
  pkg: UsecasePackage;
  spackTarget: {
    name: string;
    source: SpackCatalogSource;
  } | null;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="brand">{pkg.spec.software.kind}</Badge>
          <Badge variant="outline">v{pkg.version}</Badge>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <DetailInfoTile label="ID" value={pkg.id} />
          <DetailInfoTile
            label={t("software.detail.createdAt")}
            value={formatCreatedAt(pkg.createdAt)}
          />
          <DetailInfoTile
            label={t("software.manage.commandFile")}
            value={pkg.spec.usecase.commandFile}
          />
          <DetailInfoTile label={t("software.manage.boundSoftware")} value={softwareSummary(pkg)} />
        </div>
        {spackTarget ? (
          <div className="mt-3">
            <Button asChild variant="outline" size="sm">
              <Link
                to="/software/spack/$source/$name"
                params={{ source: spackTarget.source, name: spackTarget.name }}
              >
                <Boxes />
                {t("software.detail.openBoundPackage")}
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DetailMetricTile
          icon={<TerminalSquare />}
          label={t("software.detail.arguments")}
          value={pkg.spec.arguments.length}
        />
        <DetailMetricTile
          icon={<Braces />}
          label={t("software.detail.inputSlots")}
          value={pkg.spec.usecase.inputSlots.length}
        />
        <DetailMetricTile
          icon={<PackageCheck />}
          label={t("software.detail.files")}
          value={countUsecaseFiles(pkg)}
        />
        <DetailMetricTile
          icon={<Puzzle />}
          label={t("software.detail.environments")}
          value={pkg.spec.environments.length}
        />
      </div>
    </section>
  );
}

export function SoftwareUsecaseDetailPage({ usecaseId }: { usecaseId: string }) {
  const { t } = useTranslation();
  const usecaseQ = useQuery({
    queryKey: ["software-usecase", usecaseId],
    queryFn: () => getUsecasePackage(usecaseId),
    retry: false,
  });
  const pkg = usecaseQ.data ?? null;
  const spack = pkg?.spec.software.kind === "Spack" ? pkg.spec.software : null;
  const catalogVariantTarget = parseCatalogVariantRef(spack);
  const spackSearchName = spack ? spackDependencyPackageName(spack.name) : null;
  const spackTargetQ = useQuery({
    queryKey: ["software-usecase-spack-target", spackSearchName],
    queryFn: () => listSpackCatalog(spackSearchName ?? "", 5, "all", 1),
    enabled: !!spackSearchName && !catalogVariantTarget,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const inferredSpackTarget =
    spackSearchName && spackTargetQ.data
      ? spackTargetQ.data.packages.find((item) => item.name === spackSearchName)
      : null;
  const spackTarget = catalogVariantTarget ?? inferredSpackTarget ?? null;
  return (
    <DetailShell
      description={pkg?.description}
      icon={<FlaskConical />}
      section="usecases"
      title={pkg?.name ?? t("software.detail.usecase")}
    >
      {usecaseQ.error instanceof Error ? (
        <DetailError error={usecaseQ.error} />
      ) : !pkg && usecaseQ.isLoading ? (
        <DetailEmpty text={t("common.loading")} />
      ) : !pkg ? (
        <DetailEmpty text={t("software.detail.notFound")} />
      ) : (
        <div className="grid gap-5">
          <UsecasePackageHero pkg={pkg} spackTarget={spackTarget} />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <DetailSection title={t("software.detail.inputsOutputs")}>
              <div className="grid gap-3 lg:grid-cols-2">
                <SlotList
                  title={t("software.detail.inputSlots")}
                  rows={pkg.spec.usecase.inputSlots.map((slot) => ({
                    name: slot.descriptor,
                    value: `${slot.kind} · ${slot.refMaterials.map((ref) => ref.descriptor).join(", ")}`,
                  }))}
                />
                <SlotList
                  title={t("software.detail.arguments")}
                  rows={pkg.spec.arguments.map((arg) => ({
                    name: arg.descriptor,
                    value: arg.valueFormat,
                  }))}
                />
                <SlotList
                  title={t("software.detail.fileInputs")}
                  rows={pkg.spec.filesomeInputs.map((slot) => ({
                    name: slot.descriptor,
                    value: JSON.stringify(slot.fileKind),
                  }))}
                />
                <SlotList
                  title={t("software.detail.fileOutputs")}
                  rows={(pkg.spec.filesomeOutputs ?? []).map((slot) => ({
                    name: slot.descriptor,
                    value: JSON.stringify(slot.fileKind),
                  }))}
                />
                <SlotList
                  title={t("software.detail.environments")}
                  rows={pkg.spec.environments.map((env) => ({
                    name: env.descriptor,
                    value: `${env.key}=${env.valueFormat}`,
                  }))}
                />
              </div>
            </DetailSection>
            <aside className="grid content-start gap-3">
              <DetailSection title={t("software.detail.runtime")}>
                <div className="grid gap-3 rounded-md border border-border bg-card p-4">
                  <DetailInfoTile
                    label={t("software.manage.compiler")}
                    value={spack?.compiler ?? "—"}
                  />
                  <DetailInfoTile
                    label={t("software.manage.module")}
                    value={spack?.moduleName ?? "—"}
                  />
                  <DetailInfoTile
                    label={t("software.manage.variantRef")}
                    value={spack?.variantRef ?? "—"}
                  />
                  <DetailInfoTile
                    label={t("software.manage.variants")}
                    value={spack?.argumentList.join(" ") || "—"}
                  />
                  <DetailInfoTile
                    label={t("software.manage.softwareVersion")}
                    value={spack?.version ?? "—"}
                  />
                </div>
              </DetailSection>
            </aside>
          </div>
        </div>
      )}
    </DetailShell>
  );
}

function SlotList({ rows, title }: { rows: { name: string; value: string }[]; title: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {rows.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">{t("software.detail.none")}</div>
      ) : (
        <div className="mt-3 grid gap-2">
          {rows.map((row) => (
            <div
              key={`${row.name}:${row.value}`}
              className="min-w-0 rounded-md border border-border bg-background p-2"
            >
              <div className="font-mono text-xs font-semibold">{row.name}</div>
              <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                {row.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function parseCatalogSource(value: string): SpackCatalogSource {
  if (value === "official" || value === "vendor") return value;
  return "upstream";
}

export function SoftwareSpackDetailPage({ name, source }: { name: string; source: string }) {
  const { t } = useTranslation();
  const catalogSource = parseCatalogSource(source);
  const catalogQ = useQuery({
    queryKey: ["software-spack-catalog-detail", catalogSource, name],
    queryFn: () => listSpackCatalog(name, 100, catalogSource, 1),
    retry: false,
  });
  const pkg =
    catalogQ.data?.packages.find((item) => item.source === catalogSource && item.name === name) ??
    null;
  return (
    <DetailShell
      description={pkg?.description}
      icon={<Boxes />}
      section="spack"
      title={pkg?.name ?? t("software.detail.spackPackage")}
    >
      {catalogQ.error instanceof Error ? (
        <DetailError error={catalogQ.error} />
      ) : !pkg && catalogQ.isLoading ? (
        <DetailEmpty text={t("common.loading")} />
      ) : !pkg ? (
        <DetailEmpty text={t("software.detail.notFound")} />
      ) : (
        <SpackDetailContent pkg={pkg} />
      )}
    </DetailShell>
  );
}

function SpackDetailContent({ pkg }: { pkg: SpackCatalogPackage }) {
  const { t } = useTranslation();
  const metadata = pkg.metadata;
  const installSpec = useMemo(() => buildSpackInstallSpec(pkg, metadata), [metadata, pkg]);
  return (
    <div className="grid gap-5">
      <SpackPackageHero installSpec={installSpec} metadata={metadata} pkg={pkg} />
      <LicensePolicyPanel policy={pkg.licensePolicy} />
      <SpackAvailabilityPanel installSpec={installSpec} />
      {metadata ? (
        <SpackMetadataDetail installSpec={installSpec} metadata={metadata} pkg={pkg} />
      ) : (
        <DetailEmpty text={t("software.detail.noMetadata")} />
      )}
    </div>
  );
}

function SpackAvailabilityPanel({ installSpec }: { installSpec: string }) {
  const { t } = useTranslation();
  const availabilityQ = useQuery({
    queryKey: ["software-spack-availability", installSpec],
    queryFn: () => resolveSoftwareAvailability({ rawSpec: installSpec, installable: true }),
    retry: false,
  });
  const data = availabilityQ.data;
  return (
    <DetailSection title={t("software.detail.availability")}>
      <div className="grid gap-3 rounded-md border border-border bg-card p-4 lg:grid-cols-3">
        <AvailabilityColumn
          items={data?.installedAvailable ?? []}
          loading={availabilityQ.isLoading}
          title={t("software.detail.installedAvailable")}
        />
        <AvailabilityColumn
          items={data?.installableAvailable ?? []}
          loading={availabilityQ.isLoading}
          title={t("software.detail.installableAvailable")}
        />
        <AvailabilityColumn
          items={data?.blocked ?? []}
          loading={availabilityQ.isLoading}
          title={t("software.detail.blockedNodes")}
        />
        {availabilityQ.isError ? (
          <div className="lg:col-span-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("software.detail.availabilityFailed")}
          </div>
        ) : null}
      </div>
    </DetailSection>
  );
}

function AvailabilityColumn({
  items,
  loading,
  title,
}: {
  items: Array<{ agentId: string; siteName: string; installMode?: string; reasons: string[] }>;
  loading: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {loading ? (
        <div className="mt-3 text-xs text-muted-foreground">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">{t("software.detail.none")}</div>
      ) : (
        <div className="mt-3 grid gap-2">
          {items.slice(0, 6).map((item) => (
            <div key={item.agentId} className="rounded-md border border-border bg-card px-3 py-2">
              <div className="truncate font-mono text-xs font-semibold text-foreground">
                {item.siteName || item.agentId}
              </div>
              {item.installMode ? (
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {item.installMode}
                </div>
              ) : null}
              {item.reasons.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.reasons.slice(0, 2).map((reason) => (
                    <Badge
                      key={reason}
                      variant={title === t("software.detail.blockedNodes") ? "failed" : "outline"}
                    >
                      {softwareAvailabilityReason(reason, t)}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {items.length > 6 ? (
            <div className="text-[11px] text-muted-foreground">
              {t("software.detail.moreNodes", { count: items.length - 6 })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MetadataBadges({
  className,
  items,
  linkForItem,
}: {
  className?: string;
  items: string[];
  linkForItem?: (item: string) => { name: string; source: SpackCatalogSource } | null;
}) {
  const { t } = useTranslation();
  if (items.length === 0)
    return <span className="text-xs text-muted-foreground">{t("software.detail.none")}</span>;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {items.map((item) => {
        const linkTarget = linkForItem?.(item) ?? null;
        const badge = (
          <Badge
            key={item}
            variant="outline"
            className={cn(linkTarget && "transition-colors hover:border-brand hover:bg-brand-soft")}
          >
            {item}
          </Badge>
        );
        if (!linkTarget) return badge;
        return (
          <Link
            key={item}
            to="/software/spack/$source/$name"
            params={{ source: linkTarget.source, name: linkTarget.name }}
          >
            {badge}
          </Link>
        );
      })}
    </div>
  );
}

function SpackPackageHero({
  installSpec,
  metadata,
  pkg,
}: {
  installSpec: string;
  metadata?: SpackPackageMetadata;
  pkg: SpackCatalogPackage;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="brand">{pkg.source}</Badge>
          {pkg.ownerOrgId ? <Badge variant="outline">{pkg.ownerOrgId}</Badge> : null}
          {pkg.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            {t("software.detail.installSpec")}
          </div>
          <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
              {installSpec}
            </code>
            <CopySpecButton value={installSpec} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2">
        <SpackMetricTile
          icon={<GitBranch />}
          label={t("software.detail.versions")}
          value={metadata?.versions.length ?? 0}
        />
        <SpackMetricTile
          icon={<Puzzle />}
          label={t("software.detail.variants")}
          value={metadata?.variants.length ?? 0}
        />
        <SpackMetricTile
          icon={<PackageCheck />}
          label={t("software.detail.dependencies")}
          value={metadata?.dependencies.length ?? 0}
        />
        <SpackMetricTile
          icon={<ShieldCheck />}
          label={t("software.detail.conflicts")}
          value={metadata?.conflicts.length ?? 0}
        />
      </div>
    </section>
  );
}

function CopySpecButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      <Clipboard />
      {copied ? t("software.detail.copied") : t("software.detail.copySpec")}
    </Button>
  );
}

function SpackMetricTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 font-mono text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function SpackMetadataDetail({
  installSpec,
  metadata,
  pkg,
}: {
  installSpec: string;
  metadata: SpackPackageMetadata;
  pkg: SpackCatalogPackage;
}) {
  const { t } = useTranslation();
  const latestVersions = metadata.versions.slice(0, 12);
  const hiddenVersionCount = Math.max(0, metadata.versions.length - latestVersions.length);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-5">
        <DetailSection title={t("software.detail.versions")}>
          <div className="rounded-md border border-border bg-card p-4">
            <MetadataBadges items={latestVersions} />
            {hiddenVersionCount > 0 ? (
              <div className="mt-3 text-xs text-muted-foreground">
                {t("software.detail.moreVersions", { count: hiddenVersionCount })}
              </div>
            ) : null}
          </div>
        </DetailSection>
        <DetailSection title={t("software.detail.moduleCapabilities")}>
          <div className="grid gap-3 lg:grid-cols-2">
            <SpackVariantPanel variants={metadata.variants} />
            <SpackTokenPanel title={t("software.detail.provides")} items={metadata.provides} />
          </div>
        </DetailSection>
        <div className="grid gap-3 lg:grid-cols-2">
          <SpackTokenPanel
            items={metadata.dependencies}
            linkSource={pkg.source}
            title={t("software.detail.dependencies")}
          />
          <SpackTokenPanel items={metadata.conflicts} title={t("software.detail.conflicts")} />
        </div>
      </div>
      <aside className="grid content-start gap-3">
        <DetailSection title={t("software.detail.packageIdentity")}>
          <div className="grid gap-3 rounded-md border border-border bg-card p-4">
            <DetailInfoTile label={t("software.manage.packageName")} value={pkg.name} />
            <DetailInfoTile label="package.py" value={metadata.name ?? "—"} />
            <DetailInfoTile label={t("software.manage.catalogPackageSource")} value={pkg.source} />
            <DetailInfoTile label={t("software.detail.installSpec")} value={installSpec} />
          </div>
        </DetailSection>
        <DetailSection title={t("software.detail.maintainers")}>
          <div className="rounded-md border border-border bg-card p-4">
            <MetadataBadges items={metadata.maintainers} />
          </div>
        </DetailSection>
        <DetailSection title={t("software.detail.licenses")}>
          <div className="rounded-md border border-border bg-card p-4">
            <MetadataBadges items={metadata.licenses} />
          </div>
        </DetailSection>
        {metadata.homepage ? (
          <Button asChild variant="outline" size="sm" className="justify-start">
            <a href={metadata.homepage} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t("software.detail.homepage")}
            </a>
          </Button>
        ) : null}
      </aside>
    </div>
  );
}

function SpackVariantPanel({ variants }: { variants: SpackPackageMetadata["variants"] }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">{t("software.detail.variants")}</div>
      {variants.length === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">{t("software.detail.none")}</div>
      ) : (
        <div className="mt-3 grid gap-2">
          {variants.map((variant) => (
            <div
              key={variant.name}
              className="grid gap-2 rounded-md border border-border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-foreground">
                  {variant.name}
                </span>
                {variant.default ? <Badge variant="brand">default={variant.default}</Badge> : null}
              </div>
              {variant.description ? (
                <div className="text-xs text-muted-foreground">{variant.description}</div>
              ) : null}
              {variant.values.length > 0 ? (
                <MetadataBadges className="pt-1" items={variant.values} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpackTokenPanel({
  items,
  linkSource,
  title,
}: {
  items: string[];
  linkSource?: SpackCatalogSource;
  title: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <Badge variant="default">{items.length}</Badge>
      </div>
      <div className="mt-3">
        <MetadataBadges
          items={items}
          linkForItem={
            linkSource
              ? (item) => {
                  const name = spackDependencyPackageName(item);
                  return name ? { name, source: linkSource } : null;
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function buildSpackInstallSpec(pkg: SpackCatalogPackage, metadata?: SpackPackageMetadata): string {
  const firstVersion = metadata?.versions.find((version) => version !== "develop");
  return firstVersion ? `${pkg.name}@${firstVersion}` : pkg.name;
}

function spackDependencyPackageName(spec: string): string | null {
  const token = spec.trim().replace(/^\^+/, "").split(/\s+/)[0];
  if (!token) return null;
  const [name] = token.split(/[~+@%=]/, 1);
  return name && /^[a-z0-9][a-z0-9_.-]*$/i.test(name) ? name : null;
}
