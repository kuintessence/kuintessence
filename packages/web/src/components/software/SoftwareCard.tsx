import { Link, useNavigate } from "@tanstack/react-router";
import {
  Box,
  CalendarClock,
  CircleAlert,
  Edit3,
  Eye,
  GitBranch,
  Network,
  Star,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { stashPendingTemplate, type WorkflowTemplate } from "../../lib/software-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import {
  cardActionLayerClass,
  cardContentLayerClass,
  cardSurfaceLinkClass,
  clickableCardClass,
} from "./card-navigation";

export interface SoftwareCardProps {
  favorite?: boolean;
  onEdit?: () => void;
  onToggleFavorite?: () => void;
  view: {
    template: WorkflowTemplate;
    nodeCount: number | null;
    edgeCount: number | null;
    nodeTypes: string[];
    usecaseRefs: string[];
    softwareRefs: string[];
    isValidWorkflow: boolean;
  };
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SoftwareCard({
  favorite = false,
  onEdit,
  onToggleFavorite,
  view,
}: SoftwareCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { template } = view;
  return (
    <Card
      data-testid={`software-card-${template.id}`}
      className={`flex h-full min-w-0 flex-col ${clickableCardClass}`}
    >
      <Link
        to="/software/workflow-templates/$templateId"
        params={{ templateId: template.id }}
        className={cardSurfaceLinkClass}
        aria-label={`${t("software.manage.view")}: ${template.name}`}
        data-testid={`software-card-surface-${template.id}`}
      />
      <CardHeader
        className={`flex flex-row items-start justify-between gap-2 space-y-0 ${cardContentLayerClass}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold" title={template.name}>
            {template.name}
          </span>
        </div>
        <div className={`flex shrink-0 items-center gap-1 ${cardActionLayerClass}`}>
          {onToggleFavorite ? (
            <Button
              type="button"
              variant={favorite ? "default" : "outline"}
              size="sm"
              onClick={onToggleFavorite}
              aria-pressed={favorite}
              aria-label={favorite ? t("software.unfavorite") : t("software.favorite")}
            >
              <Star className={favorite ? "fill-current" : ""} />
              <span className="sr-only">
                {favorite ? t("software.unfavorite") : t("software.favorite")}
              </span>
            </Button>
          ) : null}
          <Badge variant="outline" className="font-mono">
            v{template.version}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className={`flex flex-1 flex-col gap-3 text-xs ${cardContentLayerClass}`}>
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span
            className="max-w-full truncate font-mono text-[11px] tabular-nums"
            title={template.id}
          >
            {template.id.length > 12 ? template.id.slice(0, 12) : template.id}
          </span>
          <span className="flex items-center gap-1">
            <CalendarClock className="h-3 w-3" />
            {formatCreatedAt(template.createdAt)}
          </span>
        </div>
        <p className="line-clamp-2 min-h-8 text-muted-foreground">
          {template.description ?? t("software.card.noDescription")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-border bg-background px-2 py-1.5">
            <div className="flex items-center gap-1 text-muted-foreground">
              <Network className="h-3 w-3" />
              {t("software.card.graph")}
            </div>
            <div className="mt-1">
              {view.nodeCount === null || view.edgeCount === null ? (
                t("software.card.invalidGraph")
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <GraphMetric label={t("software.card.nodes")} value={view.nodeCount} />
                  <GraphMetric label={t("software.card.edges")} value={view.edgeCount} />
                </div>
              )}
            </div>
          </div>
          <div className="rounded-md border border-border bg-background px-2 py-1.5">
            <div className="flex items-center gap-1 text-muted-foreground">
              <CircleAlert className="h-3 w-3" />
              {t("software.card.validation")}
            </div>
            <div className="mt-0.5 font-medium">
              {view.isValidWorkflow
                ? t("software.card.validWorkflow")
                : t("software.card.invalidWorkflow")}
            </div>
          </div>
        </div>
        {view.nodeTypes.length > 0 ? (
          <div className="flex flex-wrap gap-1" data-testid={`software-node-types-${template.id}`}>
            {view.nodeTypes.map((type) => (
              <Badge key={type} variant="outline" className="max-w-full">
                <span className="truncate">{type}</span>
              </Badge>
            ))}
          </div>
        ) : null}
        {view.usecaseRefs.length > 0 || view.softwareRefs.length > 0 ? (
          <div className="grid gap-1 rounded-md border border-border bg-background p-2">
            <RefLine label={t("software.card.usecaseRefs")} values={view.usecaseRefs} />
            <RefLine label={t("software.card.softwareRefs")} values={view.softwareRefs} />
          </div>
        ) : null}
        {template.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1" data-testid={`software-tags-${template.id}`}>
            {template.tags.map((tag) => (
              <Badge key={tag} variant="brand">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className={`mt-auto flex flex-wrap justify-end gap-2 pt-2 ${cardActionLayerClass}`}>
          <Button asChild variant="outline" size="sm" data-testid={`software-view-${template.id}`}>
            <Link
              to="/software/workflow-templates/$templateId"
              params={{ templateId: template.id }}
            >
              <Eye />
              {t("software.manage.view")}
            </Link>
          </Button>
          {onEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onEdit}
              data-testid={`software-edit-template-${template.id}`}
            >
              <Edit3 />
              {t("software.manage.edit")}
            </Button>
          ) : null}
          <Button
            size="sm"
            data-testid={`software-use-${template.id}`}
            disabled={!view.isValidWorkflow}
            title={view.isValidWorkflow ? undefined : t("software.card.invalidUseUnavailable")}
            onClick={() => {
              if (!view.isValidWorkflow) return;
              stashPendingTemplate({ yaml: template.yamlContent, source: template.name });
              toast.success(
                t("software.card.loaded", { name: template.name, version: template.version }),
              );
              navigate({ to: "/workflows/new" });
            }}
          >
            <GitBranch />
            {t("software.card.use")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RefLine({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[11px]" title={values.join(", ")}>
        {values.map((value) => (value.length > 8 ? value.slice(0, 8) : value)).join(", ")}
      </div>
    </div>
  );
}

function GraphMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-mono text-base font-semibold leading-none tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}
