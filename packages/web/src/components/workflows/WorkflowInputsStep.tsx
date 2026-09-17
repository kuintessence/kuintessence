import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronRight,
  Cloud,
  FileIcon,
  FileUp,
  FolderOpen,
  GripVertical,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import {
  forwardRef,
  type DragEvent as ReactDragEvent,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, uploadFileToNetDrive } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import type {
  WorkflowDatasetCandidate,
  WorkflowDatasetRequirement,
  WorkflowFileRequirement,
} from "../../lib/workflow-input-config";
import {
  resolveWorkflowDatasetBinding,
  sameWorkflowDatasetInput,
  smartMatchWorkflowFiles,
  type WorkflowFileCandidate,
  type WorkflowInputModel,
} from "../../lib/workflow-input-config";
import { PathPickerSheet } from "../files/PathPickerSheet";
import { fmtBytes } from "../files/path-picker-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

interface NetDriveListResp {
  success: true;
  data: {
    files: Array<{
      id: string;
      path: string;
      size: number;
      sha256: string;
    }>;
  };
}

interface UploadProgress {
  completed: number;
  currentName: string;
  total: number;
}

interface DatasetOption {
  assetId: string;
  assetKind: string;
  assetName: string;
  format: string | null;
  input: WorkflowDatasetCandidate;
  manifestDigest: string;
  schemaUri: string | null;
  sizeBytes: number | null;
  tags: string[];
  version: string;
  versionId: string;
}

interface DatasetOptionsResp {
  limit: number;
  offset: number;
  options: DatasetOption[];
  total: number;
}

interface DatasetValidationResp {
  valid: true;
}

function errorMessage(error: unknown): string | null {
  return error ? toUserFacingError(error) : null;
}

interface DroppedEntry {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
  file?: (callback: (file: File) => void, onError?: () => void) => void;
  createReader?: () => {
    readEntries: (callback: (entries: DroppedEntry[]) => void, onError?: () => void) => void;
  };
}

interface StagedLocalFile {
  file: File;
  path: string;
}

async function readDroppedEntry(entry: DroppedEntry, parent = ""): Promise<StagedLocalFile[]> {
  const path = [parent, entry.name].filter(Boolean).join("/");
  if (entry.isFile && entry.file) {
    return new Promise((resolve) =>
      entry.file?.(
        (file) => resolve([{ file, path }]),
        () => resolve([]),
      ),
    );
  }
  const reader = entry.createReader?.();
  if (!entry.isDirectory || !reader) return [];
  const children: DroppedEntry[] = [];
  while (true) {
    const batch = await new Promise<DroppedEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map((child) => readDroppedEntry(child, path)))).flat();
}

async function readDroppedFiles(event: ReactDragEvent<HTMLElement>): Promise<StagedLocalFile[]> {
  const entries = Array.from(event.dataTransfer.items).flatMap((item) => {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }
    ).webkitGetAsEntry?.();
    return entry ? [entry] : [];
  });
  if (entries.length > 0) {
    return (await Promise.all(entries.map((entry) => readDroppedEntry(entry)))).flat();
  }
  return Array.from(event.dataTransfer.files).map((file) => ({ file, path: file.name }));
}

function uniqueCandidates(candidates: WorkflowFileCandidate[]): WorkflowFileCandidate[] {
  return Array.from(new Map(candidates.map((candidate) => [candidate.id, candidate])).values());
}

function candidateDirectory(candidate: WorkflowFileCandidate): string {
  const separator = candidate.path.lastIndexOf("/");
  return separator > 0 ? candidate.path.slice(0, separator) : "";
}

interface CandidateTreeNode {
  children: CandidateTreeNode[];
  files: WorkflowFileCandidate[];
  name: string;
  path: string;
}

interface CandidateTree {
  key: string;
  label: string;
  nodes: CandidateTreeNode[];
  source: WorkflowFileCandidate["source"];
}

function buildCandidateTrees(candidates: WorkflowFileCandidate[]): CandidateTree[] {
  const roots = new Map<
    string,
    { label: string; source: WorkflowFileCandidate["source"]; nodes: Map<string, MutableTreeNode> }
  >();
  for (const candidate of candidates) {
    const rootPath = candidate.rootPath ?? candidateDirectory(candidate);
    const key = `${candidate.source}:${rootPath}`;
    const root = roots.get(key) ?? {
      label: rootPath || "/",
      source: candidate.source,
      nodes: new Map<string, MutableTreeNode>(),
    };
    const relativePath =
      rootPath && candidate.path.startsWith(rootPath)
        ? candidate.path.slice(rootPath.length).replace(/^\/+/, "")
        : candidate.path;
    const segments = relativePath.split("/").filter(Boolean);
    const directories = segments.slice(0, -1);
    let nodes = root.nodes;
    let currentPath = rootPath;
    for (const directory of directories) {
      currentPath = [currentPath, directory].filter(Boolean).join("/");
      const node = nodes.get(directory) ?? {
        children: new Map<string, MutableTreeNode>(),
        files: [],
        name: directory,
        path: currentPath,
      };
      nodes.set(directory, node);
      nodes = node.children;
    }
    if (directories.length === 0) {
      const leaf = root.nodes.get("__files__") ?? {
        children: new Map<string, MutableTreeNode>(),
        files: [],
        name: "",
        path: rootPath,
      };
      leaf.files.push(candidate);
      root.nodes.set("__files__", leaf);
    } else {
      const parent = findMutableNode(root.nodes, directories);
      parent?.files.push(candidate);
    }
    roots.set(key, root);
  }
  return [...roots.entries()]
    .map(([key, root]) => ({
      key,
      label: root.label,
      nodes: freezeTree(root.nodes),
      source: root.source,
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

interface MutableTreeNode {
  children: Map<string, MutableTreeNode>;
  files: WorkflowFileCandidate[];
  name: string;
  path: string;
}

function findMutableNode(
  nodes: Map<string, MutableTreeNode>,
  segments: string[],
): MutableTreeNode | undefined {
  let current: MutableTreeNode | undefined;
  let children = nodes;
  for (const segment of segments) {
    current = children.get(segment);
    if (!current) return undefined;
    children = current.children;
  }
  return current;
}

function freezeTree(nodes: Map<string, MutableTreeNode>): CandidateTreeNode[] {
  return [...nodes.values()]
    .map((node) => ({
      children: freezeTree(node.children),
      files: node.files.toSorted((left, right) => left.name.localeCompare(right.name)),
      name: node.name,
      path: node.path,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface WorkflowInputsStepHandle {
  confirmAssociations: () => Promise<Record<string, WorkflowFileCandidate[]> | null>;
}

interface WorkflowInputsStepProps {
  bindings: Record<string, WorkflowFileCandidate[]>;
  candidates: WorkflowFileCandidate[];
  confirmed: boolean;
  draftId: string;
  datasetBindings: Record<string, WorkflowDatasetCandidate | null>;
  model: WorkflowInputModel;
  onBindingsChange: (bindings: Record<string, WorkflowFileCandidate[]>) => void;
  onCandidatesChange: (candidates: WorkflowFileCandidate[]) => void;
  onConfirmedChange: (confirmed: boolean) => void;
  onDatasetBindingChange: (key: string, binding: WorkflowDatasetCandidate | null) => void;
  onDatasetValidityChange: (key: string, valid: boolean) => void;
  onValuesChange: (values: Record<string, string>) => void;
  values: Record<string, string>;
}

export const WorkflowInputsStep = forwardRef<WorkflowInputsStepHandle, WorkflowInputsStepProps>(
  function WorkflowInputsStep(
    {
      bindings,
      candidates,
      confirmed,
      datasetBindings,
      draftId,
      model,
      onBindingsChange,
      onCandidatesChange,
      onConfirmedChange,
      onDatasetBindingChange,
      onDatasetValidityChange,
      onValuesChange,
      values,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [cloudPickerOpen, setCloudPickerOpen] = useState(false);
    const [cloudRequirementKey, setCloudRequirementKey] = useState<string | null>(null);
    const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
    const assignedIds = useMemo(
      () => new Set(Object.values(bindings).flatMap((files) => files.map((file) => file.id))),
      [bindings],
    );
    const candidateTrees = useMemo(() => buildCandidateTrees(candidates), [candidates]);
    const requirementGroups = useMemo(() => {
      const groups = new Map<
        string,
        { nodeId: string; nodeName: string; files: WorkflowFileRequirement[] }
      >();
      for (const requirement of model.files) {
        const current = groups.get(requirement.nodeId);
        groups.set(requirement.nodeId, {
          nodeId: requirement.nodeId,
          nodeName: requirement.nodeName,
          files: [...(current?.files ?? []), requirement],
        });
      }
      return [...groups.values()];
    }, [model.files]);
    const datasetGroups = useMemo(() => {
      const groups = new Map<
        string,
        { datasets: WorkflowDatasetRequirement[]; nodeId: string; nodeName: string }
      >();
      for (const requirement of model.datasets) {
        const current = groups.get(requirement.nodeId);
        groups.set(requirement.nodeId, {
          datasets: [...(current?.datasets ?? []), requirement],
          nodeId: requirement.nodeId,
          nodeName: requirement.nodeName,
        });
      }
      return [...groups.values()];
    }, [model.datasets]);
    function addCandidates(
      nextCandidates: WorkflowFileCandidate[],
      preferredRequirementKey?: string,
    ) {
      const merged = uniqueCandidates([...candidates, ...nextCandidates]);
      const nextBindings = smartMatchWorkflowFiles(model.files, merged, bindings);
      const preferredRequirement = model.files.find(
        (requirement) => requirement.key === preferredRequirementKey,
      );
      if (preferredRequirement && nextCandidates.length > 0) {
        const preferredMatch = smartMatchWorkflowFiles([preferredRequirement], nextCandidates, {})[
          preferredRequirement.key
        ];
        nextBindings[preferredRequirement.key] = preferredRequirement.batch
          ? preferredMatch?.length
            ? preferredMatch
            : nextCandidates
          : [preferredMatch?.[0] ?? nextCandidates[0]].filter(
              (candidate): candidate is WorkflowFileCandidate => candidate !== undefined,
            );
      }
      onCandidatesChange(merged);
      onBindingsChange(nextBindings);
      onConfirmedChange(false);
    }

    async function loadCloudDirectory(prefix: string, preferredRequirementKey?: string) {
      try {
        const query = new URLSearchParams({ prefix });
        const response = await api.get<NetDriveListResp>(`/netdrive/files?${query.toString()}`);
        const loaded = response.data.files.map((file) => ({
          id: file.id,
          name: file.path.split("/").at(-1) ?? file.path,
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          source: "cloud" as const,
          rootPath: prefix,
        }));
        addCandidates(loaded, preferredRequirementKey);
        toast.success(
          t("workflows.creation.inputs.cloudLoaded", { count: response.data.files.length }),
        );
      } catch (error) {
        toast.error(toUserFacingError(error, t("common.error")));
      }
    }

    function stageLocalEntries(entries: StagedLocalFile[], preferredRequirementKey?: string) {
      if (entries.length === 0) return;
      const staged = entries.map(({ file, path }) => ({
        id: `local:${crypto.randomUUID()}`,
        name: file.name,
        path,
        size: file.size,
        source: "local" as const,
        rootPath: path.split("/")[0] ?? "",
        localFile: file,
      }));
      addCandidates(staged, preferredRequirementKey);
      toast.success(t("workflows.creation.inputs.localStaged", { count: staged.length }));
    }

    function stageLocalFiles(files: FileList | null, preferredRequirementKey?: string) {
      if (!files || files.length === 0) return;
      stageLocalEntries(
        Array.from(files).map((file) => ({
          file,
          path: file.webkitRelativePath || file.name,
        })),
        preferredRequirementKey,
      );
    }

    function removeCandidate(candidateId: string) {
      onCandidatesChange(candidates.filter((candidate) => candidate.id !== candidateId));
      onBindingsChange(
        Object.fromEntries(
          Object.entries(bindings).map(([key, files]) => [
            key,
            files.filter((file) => file.id !== candidateId),
          ]),
        ),
      );
      onConfirmedChange(false);
    }

    function assign(requirementKey: string, candidateId: string) {
      const candidate = candidates.find((item) => item.id === candidateId);
      const requirement = model.files.find((item) => item.key === requirementKey);
      if (!candidate || !requirement) return;
      const current = bindings[requirementKey] ?? [];
      onBindingsChange({
        ...bindings,
        [requirementKey]: requirement.batch
          ? uniqueCandidates([...current, candidate])
          : [candidate],
      });
      onConfirmedChange(false);
    }

    function openCloudPicker(requirementKey: string | null) {
      setCloudRequirementKey(requirementKey);
      setCloudPickerOpen(true);
    }

    async function confirmAssociations(): Promise<Record<string, WorkflowFileCandidate[]> | null> {
      const missingRequired = model.files.filter(
        (requirement) =>
          !requirement.optional &&
          (bindings[requirement.key]?.length ?? requirement.bound.length) === 0,
      );
      if (missingRequired.length > 0) {
        toast.error(t("workflows.creation.inputs.missingRequiredFiles"));
        return null;
      }
      const pending = uniqueCandidates(
        Object.values(bindings)
          .flat()
          .filter((candidate) => candidate.source === "local" && candidate.localFile),
      );
      if (pending.length === 0) {
        onConfirmedChange(true);
        toast.success(t("workflows.creation.inputs.associationsConfirmed"));
        return bindings;
      }

      setUploadProgress({
        completed: 0,
        currentName: pending[0]?.name ?? "",
        total: pending.length,
      });
      try {
        const replacements = new Map<string, WorkflowFileCandidate>();
        for (const [index, candidate] of pending.entries()) {
          const file = candidate.localFile;
          if (!file) continue;
          setUploadProgress({
            completed: index,
            currentName: candidate.name,
            total: pending.length,
          });
          const directory = candidateDirectory(candidate);
          const prefix = ["workflows", "drafts", draftId, directory].filter(Boolean).join("/");
          const uploaded = await uploadFileToNetDrive(file, prefix);
          replacements.set(candidate.id, {
            id: uploaded.id,
            name: candidate.name,
            path: uploaded.path,
            size: uploaded.size,
            sha256: uploaded.sha256,
            source: "local",
            rootPath: candidate.rootPath,
          });
          setUploadProgress({
            completed: index + 1,
            currentName: candidate.name,
            total: pending.length,
          });
        }
        const nextCandidates = candidates.map(
          (candidate) => replacements.get(candidate.id) ?? candidate,
        );
        const nextBindings = Object.fromEntries(
          Object.entries(bindings).map(([key, files]) => [
            key,
            files.map((file) => replacements.get(file.id) ?? file),
          ]),
        );
        onCandidatesChange(nextCandidates);
        onBindingsChange(nextBindings);
        onConfirmedChange(true);
        toast.success(t("workflows.creation.inputs.uploaded", { count: pending.length }));
        return nextBindings;
      } catch (error) {
        toast.error(toUserFacingError(error, t("common.error")));
        return null;
      } finally {
        setUploadProgress(null);
      }
    }

    useImperativeHandle(ref, () => ({ confirmAssociations }));

    return (
      <div className="space-y-4" data-testid="workflow-inputs-step">
        <Card className="rounded-md shadow-none">
          <CardHeader>
            <div>
              <CardTitle>{t("workflows.creation.inputs.parametersTitle")}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("workflows.creation.inputs.parametersDescription")}
              </p>
            </div>
          </CardHeader>
          <CardContent>
            {model.values.length === 0 ? (
              <EmptyMessage text={t("workflows.creation.inputs.noParameters")} />
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {model.values.map((requirement) => (
                  <label
                    key={requirement.key}
                    htmlFor={`workflow-value-${requirement.key}`}
                    className="space-y-1.5"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {requirement.label}
                      {requirement.required ? (
                        <Badge variant="outline">{t("common.required")}</Badge>
                      ) : null}
                    </span>
                    {requirement.type === "bool" ? (
                      <select
                        id={`workflow-value-${requirement.key}`}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={values[requirement.key] ?? ""}
                        onChange={(event) =>
                          onValuesChange({ ...values, [requirement.key]: event.target.value })
                        }
                      >
                        <option value="">{t("workflows.creation.inputs.notSet")}</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <Input
                        id={`workflow-value-${requirement.key}`}
                        value={values[requirement.key] ?? ""}
                        onChange={(event) =>
                          onValuesChange({ ...values, [requirement.key]: event.target.value })
                        }
                        placeholder={
                          requirement.description ??
                          t("workflows.creation.inputs.valuePlaceholder", {
                            label: requirement.label,
                          })
                        }
                        data-testid={`workflow-value-${requirement.key}`}
                      />
                    )}
                    <span className="block text-xs leading-5 text-muted-foreground">
                      {requirement.description ??
                        t("workflows.creation.inputs.valueHint", { label: requirement.label })}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-md shadow-none">
          <CardHeader>
            <CardTitle>{t("workflows.creation.inputs.datasetsTitle")}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("workflows.creation.inputs.datasetsDescription")}
            </p>
          </CardHeader>
          <CardContent className="space-y-3" data-testid="workflow-dataset-requirements">
            {model.datasets.length === 0 ? (
              <EmptyMessage text={t("workflows.creation.inputs.noDatasets")} />
            ) : (
              datasetGroups.map((group) => (
                <article
                  key={group.nodeId}
                  className="overflow-hidden rounded-lg border border-border bg-background"
                  data-testid={`workflow-dataset-node-${group.nodeId}`}
                >
                  <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{group.nodeName}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {group.nodeId}
                      </p>
                    </div>
                    <Badge variant="outline">{group.datasets.length}</Badge>
                  </header>
                  <div className="grid gap-3 p-3 xl:grid-cols-2">
                    {group.datasets.map((requirement) => (
                      <DatasetInputPicker
                        key={requirement.key}
                        onChange={(value) => onDatasetBindingChange(requirement.key, value)}
                        onValidityChange={(valid) =>
                          onDatasetValidityChange(requirement.key, valid)
                        }
                        requirement={requirement}
                        value={resolveWorkflowDatasetBinding(
                          datasetBindings,
                          requirement.key,
                          requirement.bound,
                        )}
                      />
                    ))}
                  </div>
                </article>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="rounded-md shadow-none">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle>{t("workflows.creation.inputs.filesTitle")}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("workflows.creation.inputs.filesDescription")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onBindingsChange(smartMatchWorkflowFiles(model.files, candidates, bindings));
                  onConfirmedChange(false);
                }}
                disabled={model.files.length === 0 || candidates.length === 0}
              >
                <Sparkles />
                {t("workflows.creation.inputs.smartMatch")}
              </Button>
              <Button
                type="button"
                onClick={() => void confirmAssociations()}
                disabled={model.files.length === 0 || uploadProgress !== null || confirmed}
                data-testid="workflow-confirm-file-bindings"
              >
                {confirmed ? <CheckCircle2 /> : <UploadCloud />}
                {confirmed
                  ? t("workflows.creation.inputs.associationsConfirmed")
                  : t("workflows.creation.inputs.confirmAssociations")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <section
              aria-label={t("workflows.creation.inputs.candidateFiles")}
              className="min-w-0 rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:border-brand/50"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void readDroppedFiles(event).then((entries) => stageLocalEntries(entries));
              }}
            >
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => openCloudPicker(null)}>
                  <Cloud />
                  {t("workflows.creation.inputs.chooseCloudDirectory")}
                </Button>
                <Button type="button" variant="outline" asChild>
                  <label>
                    <FileUp />
                    {t("workflows.creation.inputs.chooseLocalFile")}
                    <input
                      data-testid="workflow-choose-local-file"
                      type="file"
                      className="sr-only"
                      onChange={(event) => {
                        stageLocalFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </Button>
                <Button type="button" variant="outline" asChild>
                  <label>
                    <FolderOpen />
                    {t("workflows.creation.inputs.chooseLocalFolder")}
                    <input
                      data-testid="workflow-choose-local-folder"
                      ref={(element) => element?.setAttribute("webkitdirectory", "")}
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={(event) => {
                        stageLocalFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </Button>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {t("workflows.creation.inputs.matchHint")}
              </p>
              <div className="mt-3 space-y-3" data-testid="workflow-file-candidates">
                {candidateTrees.length === 0 ? (
                  <EmptyMessage text={t("workflows.creation.inputs.noCandidates")} />
                ) : (
                  candidateTrees.map((tree) => (
                    <div
                      key={tree.key}
                      className="overflow-hidden rounded-md border border-border bg-card"
                    >
                      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2.5 py-2 text-xs font-medium">
                        {tree.source === "local" ? (
                          <FolderOpen
                            className="h-3.5 w-3.5 text-brand"
                            aria-label={t("workflows.creation.inputs.localSource")}
                          />
                        ) : (
                          <Cloud
                            className="h-3.5 w-3.5 text-brand"
                            aria-label={t("workflows.creation.inputs.cloudSource")}
                          />
                        )}
                        <span className="truncate font-mono">
                          {tree.label || t("workflows.creation.inputs.directoryRoot")}
                        </span>
                      </div>
                      <div className="py-1">
                        <CandidateTreeBranches
                          assignedIds={assignedIds}
                          depth={1}
                          nodes={tree.nodes}
                          onRemove={removeCandidate}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="min-w-0 space-y-3" data-testid="workflow-file-requirements">
              {model.files.length === 0 ? (
                <EmptyMessage text={t("workflows.creation.inputs.noFiles")} />
              ) : (
                requirementGroups.map((group) => (
                  <article
                    key={group.nodeId}
                    className="overflow-hidden rounded-md border border-border bg-card"
                    data-testid={`workflow-file-node-${group.nodeId}`}
                  >
                    <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{group.nodeName}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {group.nodeId}
                        </p>
                      </div>
                      <Badge variant="outline">{group.files.length}</Badge>
                    </header>
                    <div className="grid gap-3 p-3 xl:grid-cols-2">
                      {group.files.map((requirement) => {
                        const assigned = bindings[requirement.key] ?? requirement.bound;
                        return (
                          <fieldset
                            key={requirement.key}
                            aria-label={`${requirement.nodeName} / ${requirement.descriptor}`}
                            className="rounded-lg border border-dashed border-border bg-background p-3 transition-colors focus-within:border-brand"
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (event.dataTransfer.files.length > 0) {
                                stageLocalFiles(event.dataTransfer.files, requirement.key);
                                return;
                              }
                              assign(
                                requirement.key,
                                event.dataTransfer.getData("application/x-kq-workflow-file"),
                              );
                            }}
                            data-testid={`workflow-file-requirement-${requirement.key}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold">
                                  {requirement.descriptor}
                                </p>
                                {requirement.expectedFileName ? (
                                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                                    {t("workflows.creation.inputs.expectedFile", {
                                      name: requirement.expectedFileName,
                                    })}
                                  </p>
                                ) : null}
                              </div>
                              <Badge variant="outline">
                                {requirement.batch
                                  ? t("workflows.creation.inputs.fileBatch")
                                  : t("workflows.creation.inputs.singleFile")}
                              </Badge>
                            </div>
                            <div className="mt-3 space-y-2">
                              <div className="flex min-h-10 min-w-0 flex-col items-stretch gap-2 rounded-md border border-dashed border-brand/35 bg-brand-soft/20 px-3 py-2">
                                {assigned.length === 0 ? (
                                  <span className="block min-w-0 truncate text-xs text-muted-foreground">
                                    {t("workflows.creation.inputs.dropHere")}
                                  </span>
                                ) : (
                                  assigned.map((candidate) => (
                                    <span
                                      key={candidate.id}
                                      className="flex min-w-0 w-full items-center gap-1 rounded-md bg-brand-soft px-2 py-1 text-xs text-brand"
                                    >
                                      <span
                                        className="min-w-0 flex-1 truncate"
                                        data-testid={`workflow-file-binding-name-${candidate.id}`}
                                      >
                                        {candidate.name}
                                      </span>
                                      <button
                                        type="button"
                                        aria-label={t("common.remove")}
                                        className="relative z-10 shrink-0"
                                        data-testid={`workflow-file-binding-remove-${candidate.id}`}
                                        onClick={() => {
                                          onBindingsChange({
                                            ...bindings,
                                            [requirement.key]: assigned.filter(
                                              (item) => item.id !== candidate.id,
                                            ),
                                          });
                                          onConfirmedChange(false);
                                        }}
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    </span>
                                  ))
                                )}
                              </div>
                              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-10 w-full"
                                  asChild
                                >
                                  <label>
                                    <FileUp />
                                    {t("workflows.creation.inputs.chooseLocalFile")}
                                    <input
                                      data-testid={`workflow-choose-local-file-${requirement.key}`}
                                      type="file"
                                      multiple={requirement.batch}
                                      className="sr-only"
                                      onChange={(event) => {
                                        stageLocalFiles(event.target.files, requirement.key);
                                        event.target.value = "";
                                      }}
                                    />
                                  </label>
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-10 w-full"
                                  asChild
                                >
                                  <label>
                                    <FolderOpen />
                                    {t("workflows.creation.inputs.chooseLocalFolder")}
                                    <input
                                      data-testid={`workflow-choose-local-folder-${requirement.key}`}
                                      ref={(element) =>
                                        element?.setAttribute("webkitdirectory", "")
                                      }
                                      type="file"
                                      multiple
                                      className="sr-only"
                                      onChange={(event) => {
                                        stageLocalFiles(event.target.files, requirement.key);
                                        event.target.value = "";
                                      }}
                                    />
                                  </label>
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-10 w-full"
                                  onClick={() => openCloudPicker(requirement.key)}
                                >
                                  <Cloud />
                                  {t("workflows.creation.inputs.chooseFromCloud")}
                                </Button>
                              </div>
                            </div>
                          </fieldset>
                        );
                      })}
                    </div>
                  </article>
                ))
              )}
            </section>
          </CardContent>
        </Card>

        <PathPickerSheet
          open={cloudPickerOpen}
          onOpenChange={setCloudPickerOpen}
          mode={cloudRequirementKey ? "file" : "directory"}
          locations={["cloud"]}
          title={t(
            cloudRequirementKey
              ? "workflows.creation.inputs.cloudFilePickerTitle"
              : "workflows.creation.inputs.cloudPickerTitle",
          )}
          description={t(
            cloudRequirementKey
              ? "workflows.creation.inputs.cloudFilePickerDescription"
              : "workflows.creation.inputs.cloudPickerDescription",
          )}
          onSelect={(selection) => {
            const requirementKey = cloudRequirementKey ?? undefined;
            if (requirementKey && selection.mode === "file" && selection.id) {
              addCandidates(
                [
                  {
                    id: selection.id,
                    name: selection.name ?? selection.path.split("/").at(-1) ?? selection.path,
                    path: selection.path,
                    rootPath: candidateDirectory({
                      id: selection.id,
                      name: selection.name ?? selection.path,
                      path: selection.path,
                      size: selection.size ?? 0,
                      source: "cloud",
                    }),
                    size: selection.size ?? 0,
                    source: "cloud",
                  },
                ],
                requirementKey,
              );
            } else {
              void loadCloudDirectory(selection.path, requirementKey);
            }
            setCloudPickerOpen(false);
            setCloudRequirementKey(null);
          }}
        />

        {uploadProgress ? <UploadOverlay progress={uploadProgress} /> : null}
      </div>
    );
  },
);

function DatasetInputPicker({
  onChange,
  onValidityChange,
  requirement,
  value,
}: {
  onChange: (value: WorkflowDatasetCandidate | null) => void;
  onValidityChange: (valid: boolean) => void;
  requirement: WorkflowDatasetRequirement;
  value: WorkflowDatasetCandidate | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const reportedValidityRef = useRef<boolean | null>(null);
  const optionsQ = useInfiniteQuery({
    queryKey: ["workflow-dataset-options", requirement.key, requirement.usecaseVersionId, query],
    enabled: requirement.usecaseVersionId !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      if (!requirement.usecaseVersionId) throw new Error("Usecase version is not resolved");
      const params = new URLSearchParams({
        descriptor: requirement.descriptor,
        limit: "25",
        offset: String(pageParam),
        q: query.trim(),
      });
      return api.get<DatasetOptionsResp>(
        `/jobs/usecase/${requirement.usecaseVersionId}/dataset-options?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.options.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    retry: false,
  });
  const bindingKey = value
    ? JSON.stringify({
        ...value,
        selectedEntries: [...value.selectedEntries].toSorted(),
        targetPath: value.targetPath ?? null,
      })
    : null;
  const validationQ = useQuery({
    queryKey: [
      "workflow-dataset-validation",
      requirement.key,
      requirement.usecaseVersionId,
      bindingKey,
    ],
    enabled: requirement.usecaseVersionId !== null && value !== null,
    queryFn: async () => {
      if (!requirement.usecaseVersionId || value === null) {
        throw new Error("Dataset binding is not available for validation");
      }
      await api.post<DatasetValidationResp>(
        `/jobs/usecase/${requirement.usecaseVersionId}/dataset-options/validate`,
        { descriptor: requirement.descriptor, input: value },
      );
      return { valid: true };
    },
    retry: false,
  });
  const options = optionsQ.data?.pages.flatMap((page) => page.options) ?? [];
  const selected = value
    ? options.find((option) => sameWorkflowDatasetInput(option.input, value))
    : undefined;
  const selectionValid =
    value === null || (!validationQ.isError && validationQ.data?.valid === true);

  useEffect(() => {
    let nextValidity: boolean | null = null;
    if (!requirement.usecaseVersionId) {
      nextValidity = false;
    } else if (value === null) {
      nextValidity = true;
    } else {
      nextValidity = !validationQ.isError && validationQ.data?.valid === true;
    }
    if (nextValidity !== null && reportedValidityRef.current !== nextValidity) {
      reportedValidityRef.current = nextValidity;
      onValidityChange(nextValidity);
    }
  }, [
    onValidityChange,
    requirement.usecaseVersionId,
    validationQ.data?.valid,
    validationQ.isError,
    value,
  ]);

  const displayedOptions =
    value && !selected
      ? [
          {
            assetId: value.assetId,
            assetKind: "",
            assetName: selectionValid
              ? t("workflows.creation.inputs.datasetSelectedCurrent")
              : t("workflows.creation.inputs.datasetSelectedUnavailable"),
            format: null,
            input: value,
            manifestDigest: value.manifestDigest,
            schemaUri: null,
            sizeBytes: null,
            tags: [],
            version: value.versionId,
            versionId: value.versionId,
          },
          ...options.filter((option) => option.versionId !== value.versionId),
        ]
      : options;

  if (!requirement.usecaseVersionId) {
    return (
      <section
        className="space-y-2 rounded-lg border border-status-failed/40 bg-status-failed/10 p-3"
        data-testid={`workflow-dataset-unresolved-${requirement.key}`}
      >
        <p className="text-sm font-semibold">{requirement.descriptor}</p>
        <p className="text-xs text-status-failed" role="alert">
          {t("workflows.creation.inputs.datasetUsecaseUnresolved")}
        </p>
      </section>
    );
  }

  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-muted/10 p-3"
      data-testid={`workflow-dataset-requirement-${requirement.key}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold">{requirement.descriptor}</p>
        <Badge variant="outline">
          {requirement.optional
            ? t("workflows.creation.inputs.datasetOptional")
            : t("workflows.creation.inputs.datasetRequired")}
        </Badge>
      </div>
      <div className="relative min-w-0">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          data-testid={`workflow-dataset-search-${requirement.key}`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("workflows.creation.inputs.datasetSearchPlaceholder")}
          value={query}
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          data-testid={`workflow-dataset-select-${requirement.key}`}
          disabled={optionsQ.isLoading || optionsQ.isError || displayedOptions.length === 0}
          onChange={(event) => {
            const option = options.find((candidate) => candidate.versionId === event.target.value);
            onValidityChange(false);
            onChange(option?.input ?? null);
          }}
          value={value?.versionId ?? ""}
        >
          <option value="">
            {optionsQ.isLoading
              ? t("workflows.creation.inputs.datasetLoading")
              : optionsQ.isError
                ? t("workflows.creation.inputs.datasetLoadFailed")
                : options.length === 0
                  ? t("workflows.creation.inputs.datasetEmpty")
                  : t("workflows.creation.inputs.datasetPlaceholder")}
          </option>
          {displayedOptions.map((option) => (
            <option key={option.versionId} value={option.versionId}>
              {option.assetName} / {option.version}
            </option>
          ))}
        </select>
        <Button
          aria-label={t("workflows.creation.inputs.refreshDatasets")}
          data-testid={`workflow-dataset-refresh-${requirement.key}`}
          disabled={optionsQ.isFetching}
          onClick={() => {
            void optionsQ.refetch();
            if (value !== null) {
              reportedValidityRef.current = false;
              onValidityChange(false);
              void validationQ.refetch();
            }
          }}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw className={optionsQ.isFetching ? "animate-spin" : undefined} />
        </Button>
        {value ? (
          <Button
            aria-label={t("workflows.creation.inputs.clearDataset")}
            data-testid={`workflow-dataset-clear-${requirement.key}`}
            onClick={() => {
              onValidityChange(true);
              onChange(null);
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
      </div>
      {optionsQ.isError || validationQ.isError ? (
        <p className="text-xs text-status-failed" role="alert">
          {errorMessage(optionsQ.error ?? validationQ.error) ??
            t("workflows.creation.inputs.datasetLoadFailed")}
        </p>
      ) : null}
      {value && !selectionValid ? (
        <p className="text-xs text-status-failed" role="alert">
          {validationQ.isError
            ? t("workflows.creation.inputs.datasetSelectionUnverified")
            : t("workflows.creation.inputs.datasetSelectionUnavailable")}
        </p>
      ) : null}
      {!optionsQ.isLoading && !optionsQ.isError && options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("workflows.creation.inputs.datasetEmptyHint")}
        </p>
      ) : null}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{selected.assetKind}</Badge>
          {selected.format ? <Badge variant="outline">{selected.format}</Badge> : null}
          {selected.sizeBytes !== null ? <span>{fmtBytes(selected.sizeBytes)}</span> : null}
          {selected.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : null}
      {optionsQ.hasNextPage ? (
        <Button
          data-testid={`workflow-dataset-load-more-${requirement.key}`}
          disabled={optionsQ.isFetchingNextPage}
          onClick={() => optionsQ.fetchNextPage()}
          size="sm"
          type="button"
          variant="outline"
        >
          {optionsQ.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
          {t("workflows.creation.inputs.datasetLoadMore")}
        </Button>
      ) : null}
    </section>
  );
}

function CandidateTreeBranches({
  assignedIds,
  depth,
  nodes,
  onRemove,
}: {
  assignedIds: Set<string>;
  depth: number;
  nodes: CandidateTreeNode[];
  onRemove: (candidateId: string) => void;
}) {
  const { t } = useTranslation();
  return nodes.map((node) => {
    if (!node.name) {
      return node.files.map((candidate) => (
        <CandidateFileRow
          assigned={assignedIds.has(candidate.id)}
          candidate={candidate}
          key={candidate.id}
          onRemove={onRemove}
        />
      ));
    }
    return (
      <details key={node.path} className="group/tree" open={depth <= 3}>
        <summary
          className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs font-medium hover:bg-muted/40"
          style={{ paddingLeft: `${Math.min(depth, 5) * 10}px` }}
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open/tree:rotate-90" />
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate" title={node.path}>
            {node.name}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {t("workflows.creation.inputs.treeItems", {
              count: node.files.length + node.children.length,
            })}
          </span>
        </summary>
        <CandidateTreeBranches
          assignedIds={assignedIds}
          depth={depth + 1}
          nodes={node.children}
          onRemove={onRemove}
        />
        {node.files.map((candidate) => (
          <CandidateFileRow
            assigned={assignedIds.has(candidate.id)}
            candidate={candidate}
            depth={depth + 1}
            key={candidate.id}
            onRemove={onRemove}
          />
        ))}
      </details>
    );
  });
}

function CandidateFileRow({
  assigned,
  candidate,
  depth = 1,
  onRemove,
}: {
  assigned: boolean;
  candidate: WorkflowFileCandidate;
  depth?: number;
  onRemove: (candidateId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex w-full items-center pr-2.5 transition-colors hover:bg-brand-soft/40"
      style={{ paddingLeft: `${Math.min(depth, 6) * 10 + 20}px` }}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) =>
          event.dataTransfer.setData("application/x-kq-workflow-file", candidate.id)
        }
        title={candidate.path}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{candidate.name}</span>
        <Badge variant={assigned ? "brand" : "outline"}>
          {candidate.source === "local"
            ? t("workflows.creation.inputs.localSource")
            : t("workflows.creation.inputs.cloudSource")}
          · {fmtBytes(candidate.size)}
        </Badge>
      </button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label={t("common.remove")}
        onClick={() => onRemove(candidate.id)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function UploadOverlay({ progress }: { progress: UploadProgress }) {
  const { t } = useTranslation();
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 p-4 backdrop-blur-md"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="workflow-upload-title"
      data-testid="workflow-upload-overlay"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Loader2 className="h-5 w-5 animate-spin" />
          </span>
          <div className="min-w-0">
            <h3 id="workflow-upload-title" className="font-semibold">
              {t("workflows.creation.inputs.uploadingTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("workflows.creation.inputs.uploadingDescription")}
            </p>
          </div>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate">{progress.currentName}</span>
          <span className="shrink-0 font-mono">
            {progress.completed}/{progress.total} · {percent}%
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyMessage({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
