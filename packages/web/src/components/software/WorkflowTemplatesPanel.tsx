import { Box, Save, Undo2, Workflow } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowTemplate, WorkflowTemplateUpdate } from "../../lib/software-client";
import { parsePublishedWorkflowTemplate, summarize } from "../../lib/workflow-parser";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input, Textarea } from "../ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { CatalogEmptyState } from "./CatalogEmptyState";
import { SoftwareCard } from "./SoftwareCard";
import { SoftwareCardGrid } from "./SoftwareCardGrid";
import { favoriteKey, ServerPagination } from "./SoftwareCatalogControls";
import { optionalText, parseTagInput, suggestNextTemplateVersion } from "./software-fields";

export interface TemplateView {
  template: WorkflowTemplate;
  nodeCount: number | null;
  edgeCount: number | null;
  nodeTypes: string[];
  usecaseRefs: string[];
  softwareRefs: string[];
  isValidWorkflow: boolean;
}

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

export function WorkflowTemplatesPanel({
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
