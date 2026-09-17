import {
  type JobDataInputs,
  type JobSubmit,
  type JobUsecaseInputs,
  type QueueRegistryView,
  QueueRegistryViewSchema,
} from "@kuintessence/shared/browser";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileIcon,
  FilePlus2,
  FlaskConical,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import {
  clearJobSubmitDraft,
  jobSubmitDraftStorageKey,
  loadJobSubmitDraft,
  saveJobSubmitDraft,
} from "../../lib/job-submit-draft";
import {
  buildSchedulingStrategy,
  type PlacementSelection,
  queueEligibility,
  queueTargetMode,
} from "../../lib/queue-selection";
import { listUsecasePackages, type UsecasePackage } from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { type PathPickerSelection, PathPickerSheet } from "../files/PathPickerSheet";
import { fmtBytes } from "../files/path-picker-utils";
import { PlacementPreviewPanel } from "../scheduler";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { CommandWorkdirDialog, type CommandWorkdirEntry } from "./CommandWorkdirDialog";

interface JobResp {
  id: string;
  name: string;
  status: string;
}

export interface SubmitJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openUsecasePickerOnOpen?: boolean;
}

type SubmitMode = "command" | "usecase";
type UsecaseRuntimeFilter = "all" | "Spack" | "Singularity" | "Bare";
type UsecaseInputFilter = "all" | "text" | "file" | "batch" | "stdin" | "dataset";
const RUNTIME_FILTERS: UsecaseRuntimeFilter[] = ["all", "Spack", "Singularity", "Bare"];
const INPUT_FILTERS: UsecaseInputFilter[] = ["all", "text", "file", "batch", "stdin", "dataset"];
const DEFAULT_COMMAND = 'echo "hello from kq"';

type UsecaseInputs = JobUsecaseInputs;

interface MaterializeResp {
  job: JobSubmit;
}

interface DatasetOption {
  assetId: string;
  assetName: string;
  assetKind: string;
  tags: string[];
  versionId: string;
  version: string;
  manifestDigest: string;
  format: string | null;
  schemaUri: string | null;
  sizeBytes: number | null;
  input: DatasetInputValue;
}

type DatasetInputValue = Extract<JobDataInputs[string], { source: "data-market" }>;

function asDatasetInput(value: JobDataInputs[string] | undefined): DatasetInputValue | undefined {
  return value?.source === "data-market" ? value : undefined;
}

interface DatasetOptionsResp {
  options: DatasetOption[];
  total: number;
  limit: number;
  offset: number;
}

function parseVisibleQueues(value: unknown): QueueRegistryView[] {
  if (typeof value !== "object" || value === null || !("queues" in value)) {
    throw new Error("Queue list response is invalid");
  }
  return QueueRegistryViewSchema.array().parse(value.queues);
}

function queueSubmissionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

interface CommandWorkdirPreviewFile {
  kind: "file";
  entry: CommandWorkdirEntry;
  name: string;
}

interface CommandWorkdirPreviewDir {
  kind: "dir";
  name: string;
  path: string;
  children: CommandWorkdirPreviewNode[];
}

type CommandWorkdirPreviewNode = CommandWorkdirPreviewDir | CommandWorkdirPreviewFile;

function softwareSummary(pkg: UsecasePackage): string {
  const software = pkg.spec.software;
  if (software.kind === "Spack") {
    return [
      `${software.name}${software.version ? `@${software.version}` : ""}`,
      ...software.argumentList,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (software.kind === "Singularity") return `${software.image}:${software.tag}`;
  return "Bare";
}

function isBatchFileSlot(pkg: UsecasePackage, descriptor: string): boolean {
  const slot = pkg.spec.usecase.inputSlots.find((item) => item.descriptor === descriptor);
  const fileRef = slot?.refMaterials.find((ref) => ref.kind === "FileInputRef");
  if (!fileRef || fileRef.kind !== "FileInputRef") return false;
  const material = pkg.spec.filesomeInputs.find((item) => item.descriptor === fileRef.descriptor);
  return material?.fileKind.kind === "Batched";
}

function isStdinTextSlot(pkg: UsecasePackage, descriptor: string): boolean {
  const slot = pkg.spec.usecase.inputSlots.find((item) => item.descriptor === descriptor);
  return slot?.refMaterials.some((ref) => ref.kind === "StdinRef") ?? false;
}

function isInternalScriptSlot(slot: UsecasePackage["spec"]["usecase"]["inputSlots"][number]) {
  const normalized = slot.descriptor.trim().toLowerCase();
  return (
    slot.kind === "Text" &&
    ["script", "shell", "shell_script", "command", "cmd"].includes(normalized) &&
    slot.refMaterials.some((ref) => ref.kind === "ArgRef" || ref.kind === "StdinRef")
  );
}

function visibleInputSlots(pkg: UsecasePackage) {
  return pkg.spec.usecase.inputSlots.filter((slot) => !isInternalScriptSlot(slot));
}

function isDomainUsecase(pkg: UsecasePackage): boolean {
  return !pkg.spec.usecase.inputSlots.some(isInternalScriptSlot);
}

function usecaseMatches(pkg: UsecasePackage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    pkg.name,
    pkg.version,
    pkg.description ?? "",
    softwareSummary(pkg),
    ...visibleInputSlots(pkg).map((slot) => slot.descriptor),
    ...datasetInputs(pkg).map((input) => input.descriptor),
    ...(pkg.spec.filesomeOutputs ?? []).map((slot) => slot.descriptor),
  ].some((value) => value.toLowerCase().includes(q));
}

function matchesUsecaseSoftware(pkg: UsecasePackage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const software = pkg.spec.software;
  const values = [softwareSummary(pkg), software.kind];
  if (software.kind === "Spack") values.push(software.name, software.version ?? "");
  if (software.kind === "Singularity") values.push(software.image, software.tag);
  return values.some((value) => value.toLowerCase().includes(q));
}

function usecaseInputKinds(pkg: UsecasePackage): Set<UsecaseInputFilter> {
  const kinds = new Set<UsecaseInputFilter>();
  for (const slot of visibleInputSlots(pkg)) {
    if (slot.kind === "Text") {
      kinds.add(isStdinTextSlot(pkg, slot.descriptor) ? "stdin" : "text");
    } else {
      kinds.add(isBatchFileSlot(pkg, slot.descriptor) ? "batch" : "file");
    }
  }
  if (datasetInputs(pkg).length > 0) kinds.add("dataset");
  return kinds;
}

function matchesInputFilter(pkg: UsecasePackage, filter: UsecaseInputFilter): boolean {
  return filter === "all" || usecaseInputKinds(pkg).has(filter);
}

function runtimeFilterLabel(
  t: ReturnType<typeof useTranslation>["t"],
  filter: UsecaseRuntimeFilter,
): string {
  if (filter === "all") {
    return t("jobs.usecase.allRuntimes", { defaultValue: "All runtimes" });
  }
  return filter;
}

function inputFilterLabel(
  t: ReturnType<typeof useTranslation>["t"],
  filter: UsecaseInputFilter,
): string {
  const labels = {
    all: t("jobs.usecase.allInputs", { defaultValue: "All inputs" }),
    text: t("jobs.usecase.textInputs", { defaultValue: "Text" }),
    file: t("jobs.usecase.fileInputs", { defaultValue: "File" }),
    batch: t("jobs.usecase.batchInputs", { defaultValue: "Batch file" }),
    stdin: t("jobs.usecase.stdinInputs", { defaultValue: "Stdin" }),
    dataset: t("jobs.usecase.datasetInputs", { defaultValue: "Dataset" }),
  };
  return labels[filter];
}

function usecaseFieldId(descriptor: string): string {
  return `submit-usecase-input-${descriptor.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function datasetInputs(pkg: UsecasePackage | null) {
  if (pkg?.spec.softwareRef === undefined) return [];
  return pkg.spec.inputs.filter((input) => input.type === "Dataset");
}

function usecaseInputCount(pkg: UsecasePackage): number {
  return visibleInputSlots(pkg).length + datasetInputs(pkg).length;
}

function usecaseReady(
  pkg: UsecasePackage | null,
  inputs: UsecaseInputs,
  dataInputs: JobDataInputs,
  dataInputValidity: Record<string, boolean>,
): boolean {
  if (!pkg) return false;
  const materialInputsReady = visibleInputSlots(pkg).every((slot) => {
    const value = inputs[slot.descriptor];
    if (slot.kind === "Text") {
      return typeof value === "string" && value.trim().length > 0;
    }
    if (isBatchFileSlot(pkg, slot.descriptor)) {
      return Array.isArray(value) && value.length > 0;
    }
    return value !== null && typeof value === "object" && !Array.isArray(value);
  });
  return (
    materialInputsReady &&
    datasetInputs(pkg).every((input) => {
      const selected = dataInputs[input.descriptor] !== undefined;
      if (!selected) return !input.required;
      return dataInputValidity[input.descriptor] === true;
    })
  );
}

function DatasetInputPicker({
  activeOrganizationId,
  descriptor,
  onChange,
  onValidityChange,
  usecaseId,
  value,
}: {
  activeOrganizationId: string | null;
  descriptor: string;
  onChange: (value: DatasetInputValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  usecaseId: string;
  value: DatasetInputValue | undefined;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectionVerified, setSelectionVerified] = useState(value === undefined);
  const optionsQ = useInfiniteQuery({
    queryKey: ["usecase-dataset-options", activeOrganizationId, usecaseId, descriptor, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        descriptor,
        q: query.trim(),
        limit: "25",
        offset: String(pageParam),
      });
      return api.get<DatasetOptionsResp>(
        `/jobs/usecase/${usecaseId}/dataset-options?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.options.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    retry: false,
  });
  const options = optionsQ.data?.pages.flatMap((page) => page.options) ?? [];
  const selected = options.find((option) => option.versionId === value?.versionId);
  const selectionValid = value === undefined || selectionVerified;

  useEffect(() => {
    if (value === undefined) {
      setSelectionVerified(true);
      onValidityChange(true);
    } else if (optionsQ.isError) {
      setSelectionVerified(false);
      onValidityChange(false);
    } else if (!optionsQ.isFetching && query.trim().length === 0) {
      const valid = selected !== undefined;
      setSelectionVerified(valid);
      onValidityChange(valid);
    }
  }, [onValidityChange, optionsQ.isError, optionsQ.isFetching, query, selected, value]);

  const displayedOptions =
    value && !selected
      ? [
          {
            assetId: value.assetId,
            assetName: selectionValid
              ? t("jobs.usecase.datasetSelectedCurrent")
              : t("jobs.usecase.datasetSelectedUnavailable"),
            assetKind: "",
            tags: [],
            versionId: value.versionId,
            version: value.versionId,
            manifestDigest: value.manifestDigest,
            format: null,
            schemaUri: null,
            sizeBytes: null,
            input: value,
          },
          ...options,
        ]
      : options;

  return (
    <div className="space-y-2" data-testid={`submit-usecase-dataset-${descriptor}`}>
      <div className="relative min-w-0">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          data-testid={`submit-usecase-dataset-search-${descriptor}`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("jobs.usecase.datasetSearchPlaceholder")}
          value={query}
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          data-testid={`submit-usecase-dataset-select-${descriptor}`}
          disabled={optionsQ.isLoading || optionsQ.isError || displayedOptions.length === 0}
          onChange={(event) => {
            const option = options.find((candidate) => candidate.versionId === event.target.value);
            setSelectionVerified(option !== undefined);
            onValidityChange(option !== undefined);
            onChange(option?.input);
          }}
          value={value?.versionId ?? ""}
        >
          <option value="">
            {optionsQ.isLoading
              ? t("jobs.usecase.datasetLoading")
              : optionsQ.isError
                ? t("jobs.usecase.datasetLoadFailed")
                : options.length === 0
                  ? t("jobs.usecase.datasetEmpty")
                  : t("jobs.usecase.datasetPlaceholder")}
          </option>
          {displayedOptions.map((option) => (
            <option key={option.versionId} value={option.versionId}>
              {option.assetName} / {option.version}
            </option>
          ))}
        </select>
        <Button
          aria-label={t("jobs.usecase.refreshDatasets")}
          data-testid={`submit-usecase-dataset-refresh-${descriptor}`}
          disabled={optionsQ.isFetching}
          onClick={() => optionsQ.refetch()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw className={optionsQ.isFetching ? "animate-spin" : undefined} />
        </Button>
        {value ? (
          <Button
            aria-label={t("jobs.usecase.clearDataset")}
            data-testid={`submit-usecase-dataset-clear-${descriptor}`}
            onClick={() => onChange(undefined)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
      </div>
      {optionsQ.isError ? (
        <p className="text-xs text-status-failed" role="alert">
          {toUserFacingError(optionsQ.error, t("jobs.usecase.datasetLoadFailed"))}
        </p>
      ) : null}
      {value && !selectionValid ? (
        <p className="text-xs text-status-failed" role="alert">
          {optionsQ.isError
            ? t("jobs.usecase.datasetSelectionUnverified")
            : t("jobs.usecase.datasetSelectionUnavailable")}
        </p>
      ) : null}
      {!optionsQ.isLoading && !optionsQ.isError && options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("jobs.usecase.datasetEmptyHint")}</p>
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
          data-testid={`submit-usecase-dataset-load-more-${descriptor}`}
          disabled={optionsQ.isFetchingNextPage}
          onClick={() => optionsQ.fetchNextPage()}
          size="sm"
          type="button"
          variant="outline"
        >
          {optionsQ.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
          {t("jobs.usecase.datasetLoadMore")}
        </Button>
      ) : null}
    </div>
  );
}

function commandInputStaging(
  entries: CommandWorkdirEntry[],
): NonNullable<JobSubmit["inputStaging"]> {
  return entries.map((entry) => ({
    fileMetadataId: entry.fileMetadataId,
    stagePath: entry.stagePath.trim(),
  }));
}

function commandWorkdirBytes(entries: CommandWorkdirEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
}

function commandWorkdirFolderCount(folders: string[]): number {
  return new Set(folders.map((folder) => folder.replace(/\/+$/, "")).filter(Boolean)).size;
}

function stagePathSegments(path: string): string[] {
  return path
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function safeStageTestId(path: string): string {
  return (
    path
      .trim()
      .replaceAll(/[^a-zA-Z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .toLowerCase() || "root"
  );
}

function sortPreviewNodes(nodes: CommandWorkdirPreviewNode[]): CommandWorkdirPreviewNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildCommandWorkdirPreviewTree(
  entries: CommandWorkdirEntry[],
  folders: string[],
): CommandWorkdirPreviewNode[] {
  const root: CommandWorkdirPreviewDir = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
  };

  for (const folder of folders) {
    insertPreviewFolder(root, stagePathSegments(folder));
  }

  for (const entry of entries) {
    const segments = stagePathSegments(entry.stagePath);
    if (segments.length === 0) continue;
    let cursor = root;
    cursor = insertPreviewFolder(cursor, segments.slice(0, -1));
    const name = segments.at(-1);
    if (!name) continue;
    cursor.children.push({ kind: "file", entry, name });
  }

  const sortDeep = (nodes: CommandWorkdirPreviewNode[]): CommandWorkdirPreviewNode[] =>
    sortPreviewNodes(nodes).map((node) =>
      node.kind === "dir" ? { ...node, children: sortDeep(node.children) } : node,
    );

  return sortDeep(root.children);
}

function insertPreviewFolder(
  root: CommandWorkdirPreviewDir,
  segments: string[],
): CommandWorkdirPreviewDir {
  let cursor = root;
  for (const segment of segments) {
    const path = cursor.path ? `${cursor.path}/${segment}` : segment;
    const existing = cursor.children.find(
      (node): node is CommandWorkdirPreviewDir => node.kind === "dir" && node.name === segment,
    );
    if (existing) {
      cursor = existing;
      continue;
    }
    const next: CommandWorkdirPreviewDir = {
      kind: "dir",
      name: segment,
      path,
      children: [],
    };
    cursor.children.push(next);
    cursor = next;
  }
  return cursor;
}

function previewDirFileCount(dir: CommandWorkdirPreviewDir): number {
  return dir.children.reduce(
    (count, child) => count + (child.kind === "dir" ? previewDirFileCount(child) : 1),
    0,
  );
}

function CommandWorkdirPreviewTree({
  entries,
  folders,
  t,
}: {
  entries: CommandWorkdirEntry[];
  folders: string[];
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const nodes = buildCommandWorkdirPreviewTree(entries, folders);

  const renderNode = (node: CommandWorkdirPreviewNode, depth: number) => {
    const paddingLeft = `calc(${depth * 1.25}rem + 0.75rem)`;
    if (node.kind === "dir") {
      const fileCount = previewDirFileCount(node);
      return (
        <div
          className="min-w-0 space-y-1"
          data-testid={`submit-command-workdir-tree-dir-${safeStageTestId(node.path)}`}
          key={`dir:${node.path}`}
        >
          <div
            className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 py-2 pr-3"
            style={{ paddingLeft }}
          >
            <Folder className="h-4 w-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={node.path}>
              {node.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {fileCount === 0
                ? t("jobs.commandWorkdir.emptyFolder", {
                    defaultValue: "Empty folder",
                  })
                : t("jobs.commandWorkdir.fileCount", {
                    count: fileCount,
                    defaultValue: "{{count}} files",
                  })}
            </span>
          </div>
          <div className="space-y-1">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        </div>
      );
    }
    const stagePath = node.entry.stagePath.trim();
    return (
      <div
        className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background py-2 pr-3"
        data-testid={`submit-command-workdir-tree-file-${safeStageTestId(stagePath)}`}
        key={`file:${node.entry.id}:${stagePath}`}
        style={{ paddingLeft }}
      >
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs" title={stagePath}>
            {node.name}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
            title={node.entry.cloudPath}
          >
            {node.entry.cloudPath}
          </div>
        </div>
        <Badge className="shrink-0" variant={node.entry.source === "upload" ? "brand" : "outline"}>
          {node.entry.source === "upload"
            ? t("jobs.commandWorkdir.uploadSource", {
                defaultValue: "Upload",
              })
            : t("jobs.commandWorkdir.cloudSource", {
                defaultValue: "Cloud",
              })}
        </Badge>
      </div>
    );
  };

  return (
    <div
      className="mt-3 max-h-56 space-y-1 overflow-auto rounded-md border border-border bg-muted/10 p-2"
      data-testid="submit-command-workdir-preview"
    >
      {nodes.map((node) => renderNode(node, 0))}
    </div>
  );
}

export function SubmitJobDialog({
  open,
  onOpenChange,
  openUsecasePickerOnOpen = false,
}: SubmitJobDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SubmitMode>("usecase");
  const [name, setName] = useState("");
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [cpus, setCpus] = useState(1);
  const [memMb, setMemMb] = useState(1024);
  const [placementSelection, setPlacementSelection] = useState<PlacementSelection>({
    mode: "auto",
  });
  const [recentQueueIds, setRecentQueueIds] = useState({ default: "", named: "" });
  const [legacyQueueId, setLegacyQueueId] = useState<string | null>(null);
  const [invalidQueueId, setInvalidQueueId] = useState<string | null>(null);
  const [queueSubmitError, setQueueSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [usecasePickerOpen, setUsecasePickerOpen] = useState(false);
  const [selectedUsecaseId, setSelectedUsecaseId] = useState<string | null>(null);
  const [usecaseInputs, setUsecaseInputs] = useState<UsecaseInputs>({});
  const [usecaseDataInputs, setUsecaseDataInputs] = useState<JobDataInputs>({});
  const [usecaseDataInputValidity, setUsecaseDataInputValidity] = useState<Record<string, boolean>>(
    {},
  );
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [commandWorkdirOpen, setCommandWorkdirOpen] = useState(false);
  const [commandWorkdirEntries, setCommandWorkdirEntries] = useState<CommandWorkdirEntry[]>([]);
  const [commandWorkdirFolders, setCommandWorkdirFolders] = useState<string[]>([]);
  const [commandDraftId] = useState(
    () => `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const queryClient = useQueryClient();
  const activeOrganizationId = useActiveOrganizationId();
  const restoredDraftForUsecase = useRef<string | null>(null);
  const draftCleared = useRef(false);
  const [draftHydratedForKey, setDraftHydratedForKey] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const draftStorageKey = jobSubmitDraftStorageKey({
    email: getAuthState().email,
    organizationId: activeOrganizationId,
  });

  const resetForm = useCallback(() => {
    setMode("usecase");
    setName("");
    setCommand(DEFAULT_COMMAND);
    setCpus(1);
    setMemMb(1024);
    setPlacementSelection({ mode: "auto" });
    setRecentQueueIds({ default: "", named: "" });
    setLegacyQueueId(null);
    setInvalidQueueId(null);
    setQueueSubmitError(null);
    setSelectedUsecaseId(null);
    setUsecaseInputs({});
    setUsecaseDataInputs({});
    setUsecaseDataInputValidity({});
    setPickerSlot(null);
    setCommandWorkdirEntries([]);
    setCommandWorkdirFolders([]);
    restoredDraftForUsecase.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      setDraftHydratedForKey(null);
      draftCleared.current = false;
      setDraftRestored(false);
      return;
    }
    setDraftHydratedForKey(null);
    const draft = loadJobSubmitDraft(draftStorageKey);
    if (draft) {
      setMode(draft.mode);
      setName(draft.name);
      setCommand(draft.command);
      setCpus(draft.cpus);
      setMemMb(draft.memMb);
      const draftPlacement = draft.placementSelection;
      setPlacementSelection(draftPlacement);
      if (draftPlacement.mode !== "auto") {
        setRecentQueueIds((current) => ({
          ...current,
          [draftPlacement.mode]: draftPlacement.queueId,
        }));
      }
      setLegacyQueueId(draft.legacyQueueId ?? null);
      setInvalidQueueId(null);
      setQueueSubmitError(null);
      setSelectedUsecaseId(draft.selectedUsecaseId);
      restoredDraftForUsecase.current = draft.selectedUsecaseId;
      setUsecaseInputs(draft.usecaseInputs);
      setUsecaseDataInputs(draft.usecaseDataInputs);
      setCommandWorkdirEntries(draft.commandWorkdirEntries);
      setCommandWorkdirFolders(draft.commandWorkdirFolders);
      setDraftRestored(true);
    } else {
      resetForm();
      setDraftRestored(false);
    }
    setDraftHydratedForKey(draftStorageKey);
  }, [draftStorageKey, open, resetForm]);

  const usecasesQ = useQuery({
    queryKey: ["software-usecases", activeOrganizationId],
    queryFn: () => listUsecasePackages(),
    enabled: open,
    retry: false,
  });
  const queuesQ = useQuery({
    queryKey: ["queues-visible", activeOrganizationId],
    queryFn: async () => parseVisibleQueues(await api.get<unknown>("/queues/visible")),
    enabled: open,
    retry: false,
  });
  const usecases = usecasesQ.data ?? [];
  const selectableUsecases = useMemo(() => usecases.filter(isDomainUsecase), [usecases]);
  const queues = queuesQ.data ?? [];
  const schedulingStrategy = buildSchedulingStrategy(placementSelection);
  const selectedQueue =
    placementSelection.mode === "auto"
      ? null
      : (queues.find(
          (queue) =>
            queue.queueId === placementSelection.queueId &&
            queueTargetMode(queue) === placementSelection.mode,
        ) ?? null);
  const selectedQueueEligibility = selectedQueue ? queueEligibility(selectedQueue) : null;
  const explicitPlacementBlocked =
    placementSelection.mode !== "auto" &&
    (Boolean(invalidQueueId) ||
      Boolean(queuesQ.error) ||
      !selectedQueue ||
      selectedQueueEligibility?.state === "blocked");
  const defaultQueues = useMemo(
    () => queues.filter((queue) => queueTargetMode(queue) === "default"),
    [queues],
  );
  const namedQueues = useMemo(
    () => queues.filter((queue) => queueTargetMode(queue) === "named"),
    [queues],
  );
  const selectedUsecase = selectableUsecases.find((pkg) => pkg.id === selectedUsecaseId) ?? null;
  const selectedUsecaseName = selectedUsecase?.name;
  const selectedUsecaseSignature = selectedUsecase
    ? `${selectedUsecase.id}:${selectedUsecase.name}`
    : "";
  const usecaseAutoNames = useMemo(
    () => new Set(usecases.map((pkg) => `${pkg.name}-run`)),
    [usecases],
  );
  const canSubmitCommand = mode === "command" && !!name.trim() && !!command.trim();
  const canSubmitUsecase =
    mode === "usecase" &&
    !!name.trim() &&
    usecaseReady(selectedUsecase, usecaseInputs, usecaseDataInputs, usecaseDataInputValidity);
  const canPreview =
    (mode === "command" ? canSubmitCommand : canSubmitUsecase) && !explicitPlacementBlocked;
  const commandWorkdirSize = commandWorkdirBytes(commandWorkdirEntries);
  const commandWorkdirFolderTotal = commandWorkdirFolderCount(commandWorkdirFolders);

  useEffect(() => {
    if (!open) {
      setUsecasePickerOpen(false);
      return;
    }
    if (openUsecasePickerOnOpen) {
      setMode("usecase");
      setUsecasePickerOpen(true);
    }
  }, [open, openUsecasePickerOnOpen]);

  useEffect(() => {
    if (!selectedUsecaseId && selectableUsecases[0]) {
      setSelectedUsecaseId(selectableUsecases[0].id);
    } else if (
      selectedUsecaseId &&
      !selectableUsecases.some((pkg) => pkg.id === selectedUsecaseId)
    ) {
      setSelectedUsecaseId(selectableUsecases[0]?.id ?? null);
    }
  }, [selectableUsecases, selectedUsecaseId]);

  useEffect(() => {
    if (!selectedUsecaseSignature || !selectedUsecaseName) return;
    if (restoredDraftForUsecase.current === selectedUsecaseId) {
      restoredDraftForUsecase.current = null;
      return;
    }
    const nextAutoName = `${selectedUsecaseName}-run`;
    setName((current) => {
      if (!current.trim() || usecaseAutoNames.has(current)) return nextAutoName;
      return current;
    });
    setUsecaseInputs({});
    setUsecaseDataInputs({});
    setUsecaseDataInputValidity({});
  }, [selectedUsecaseId, selectedUsecaseName, selectedUsecaseSignature, usecaseAutoNames]);

  useEffect(() => {
    if (!open || queuesQ.isLoading || queuesQ.error) return;
    if (legacyQueueId) {
      const queue = queues.find((item) => item.queueId === legacyQueueId);
      const targetMode = queue ? queueTargetMode(queue) : null;
      if (queue && targetMode) {
        setPlacementSelection({ mode: targetMode, queueId: queue.queueId });
        setRecentQueueIds((current) => ({ ...current, [targetMode]: queue.queueId }));
        setInvalidQueueId(null);
      } else {
        setPlacementSelection({ mode: "named", queueId: legacyQueueId });
        setInvalidQueueId(legacyQueueId);
      }
      setLegacyQueueId(null);
      return;
    }
    if (placementSelection.mode === "auto" || !placementSelection.queueId) return;
    const queue = queues.find(
      (item) =>
        item.queueId === placementSelection.queueId &&
        queueTargetMode(item) === placementSelection.mode,
    );
    setInvalidQueueId(queue ? null : placementSelection.queueId);
  }, [legacyQueueId, open, placementSelection, queues, queuesQ.error, queuesQ.isLoading]);

  useEffect(() => {
    if (!open || busy || !draftStorageKey || draftHydratedForKey !== draftStorageKey) return;
    if (draftCleared.current) return;
    saveJobSubmitDraft(draftStorageKey, {
      mode,
      name,
      command,
      cpus,
      memMb,
      placementSelection,
      selectedUsecaseId,
      usecaseInputs,
      usecaseDataInputs,
      commandWorkdirEntries,
      commandWorkdirFolders,
    });
  }, [
    busy,
    command,
    commandWorkdirEntries,
    commandWorkdirFolders,
    cpus,
    draftStorageKey,
    draftHydratedForKey,
    memMb,
    mode,
    name,
    open,
    placementSelection,
    selectedUsecaseId,
    usecaseDataInputs,
    usecaseInputs,
  ]);

  const getCommandJobSpec = useCallback((): JobSubmit | null => {
    if (!name.trim() || !command.trim()) return null;
    const inputStaging = commandInputStaging(commandWorkdirEntries);
    return {
      name: name.trim(),
      command,
      resources: { cpus, memoryMb: memMb },
      ...(inputStaging.length > 0 ? { inputStaging } : {}),
      ...(schedulingStrategy ? { schedulingStrategy } : {}),
    };
  }, [name, command, commandWorkdirEntries, cpus, memMb, schedulingStrategy]);

  const usecasePayload = useCallback(() => {
    if (
      !selectedUsecase ||
      !name.trim() ||
      !usecaseReady(selectedUsecase, usecaseInputs, usecaseDataInputs, usecaseDataInputValidity)
    ) {
      return null;
    }
    return {
      name: name.trim(),
      usecasePackageId: selectedUsecase.id,
      inputs: usecaseInputs,
      ...(Object.keys(usecaseDataInputs).length > 0 ? { dataInputs: usecaseDataInputs } : {}),
      resources: { cpus, memoryMb: memMb },
      ...(schedulingStrategy ? { schedulingStrategy } : {}),
    };
  }, [
    cpus,
    memMb,
    name,
    schedulingStrategy,
    selectedUsecase,
    usecaseDataInputs,
    usecaseDataInputValidity,
    usecaseInputs,
  ]);

  const getJobSpec = useCallback(async (): Promise<JobSubmit | null> => {
    if (mode === "command") return getCommandJobSpec();
    const payload = usecasePayload();
    if (!payload) return null;
    const materialized = await api.post<MaterializeResp>("/jobs/usecase/materialize", payload);
    return materialized.job;
  }, [getCommandJobSpec, mode, usecasePayload]);

  function setTextInput(descriptor: string, value: string) {
    setUsecaseInputs((current) => ({ ...current, [descriptor]: value }));
  }

  function removeFileInput(descriptor: string, fileMetadataId?: string) {
    setUsecaseInputs((current) => {
      const value = current[descriptor];
      if (!Array.isArray(value)) {
        const next = { ...current };
        delete next[descriptor];
        return next;
      }
      return {
        ...current,
        [descriptor]: value.filter((file) => file.fileMetadataId !== fileMetadataId),
      };
    });
  }

  function applyFileSelection(selection: PathPickerSelection) {
    if (!pickerSlot || !selectedUsecase || !selection.id) {
      toast.error(
        t("jobs.usecase.fileSelectionInvalid", { defaultValue: "Choose a NetDrive file" }),
      );
      return;
    }
    const nextFile = {
      fileMetadataId: selection.id,
      fileMetadataName: selection.name ?? selection.path.split("/").pop() ?? selection.path,
    };
    if (isBatchFileSlot(selectedUsecase, pickerSlot)) {
      setUsecaseInputs((current) => {
        const existing = current[pickerSlot];
        const files = Array.isArray(existing) ? existing : [];
        if (files.some((file) => file.fileMetadataId === nextFile.fileMetadataId)) return current;
        return { ...current, [pickerSlot]: [...files, nextFile] };
      });
    } else {
      setUsecaseInputs((current) => ({ ...current, [pickerSlot]: nextFile }));
    }
    setPickerSlot(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t("jobs.nameRequired"));
      return;
    }
    if (mode === "usecase" && !canSubmitUsecase) {
      toast.error(t("jobs.usecase.inputRequired", { defaultValue: "Complete required inputs" }));
      return;
    }
    if (explicitPlacementBlocked) {
      setQueueSubmitError(
        t("jobs.queueSelectionInvalid", {
          defaultValue: "Choose an available queue target or switch to Auto placement.",
        }),
      );
      return;
    }
    setBusy(true);
    try {
      const payload = usecasePayload();
      const commandPayload = getCommandJobSpec();
      const r =
        mode === "usecase" && payload
          ? await api.post<JobResp>("/jobs/usecase", payload)
          : commandPayload
            ? await api.post<JobResp>("/jobs", commandPayload)
            : null;
      if (!r) {
        toast.error(t("jobs.submitFailed"));
        return;
      }
      toast.success(t("jobs.submitted", { name: r.name, id: r.id.slice(0, 8) }));
      queryClient.invalidateQueries({ queryKey: ["jobs-list"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      draftCleared.current = true;
      clearJobSubmitDraft(draftStorageKey);
      onOpenChange(false);
      resetForm();
    } catch (err) {
      const code = queueSubmissionErrorCode(err);
      if (code === "QUEUE_UNAVAILABLE") {
        setQueueSubmitError(
          t("jobs.queueUnavailable", {
            defaultValue:
              "This queue target is no longer available. Choose another target or Auto placement.",
          }),
        );
      } else if (code === "QUEUE_INVENTORY_UNAVAILABLE") {
        setQueueSubmitError(
          t("jobs.queueInventoryUnavailable", {
            defaultValue: "Queue observation is temporarily unavailable. Retry after it recovers.",
          }),
        );
      }
      toast.error(toUserFacingError(err, t("jobs.submitFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="submit-job-dialog" width="max-w-4xl">
        <SheetHeader>
          <SheetTitle>{t("jobs.submitJobTitle")}</SheetTitle>
          <SheetDescription>{t("jobs.submitJobDesc")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id="submit-job-form" onSubmit={onSubmit} className="space-y-4">
            {draftRestored ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand/40 bg-brand/5 px-3 py-2 text-sm"
                data-testid="submit-job-draft-restored"
              >
                <span>
                  {t("jobs.draftRestored", {
                    defaultValue: "Your unsent job draft has been restored for this organization.",
                  })}
                </span>
                <Button
                  onClick={() => {
                    draftCleared.current = true;
                    clearJobSubmitDraft(draftStorageKey);
                    resetForm();
                    draftCleared.current = false;
                    setDraftRestored(false);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("jobs.discardDraft", { defaultValue: "Discard draft" })}
                </Button>
              </div>
            ) : null}
            <Tabs value={mode} onValueChange={(value) => setMode(value as SubmitMode)}>
              <TabsList data-testid="submit-job-mode-tabs">
                <TabsTrigger
                  value="usecase"
                  onClick={() => setMode("usecase")}
                  data-testid="submit-mode-usecase"
                >
                  <FlaskConical />
                  {t("jobs.usecase.mode", { defaultValue: "Usecase" })}
                </TabsTrigger>
                <TabsTrigger
                  value="command"
                  onClick={() => setMode("command")}
                  data-testid="submit-mode-command"
                >
                  <TerminalSquare />
                  {t("jobs.commandMode", { defaultValue: "Command" })}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="usecase" className="space-y-4 pt-3">
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-card p-3">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div className="min-w-0">
                        <div className="text-xs font-medium uppercase text-muted-foreground">
                          {t("jobs.usecase.selected", { defaultValue: "Selected usecase" })}
                        </div>
                        {selectedUsecase ? (
                          <div className="mt-1 min-w-0">
                            <div className="truncate text-sm font-semibold">
                              {selectedUsecase.name}
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {softwareSummary(selectedUsecase)}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-muted-foreground">
                            {usecasesQ.isLoading
                              ? t("common.loading")
                              : usecasesQ.error
                                ? t("software.unreachable")
                                : t("jobs.usecase.empty", {
                                    defaultValue: "No usecase selected",
                                  })}
                          </p>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                        {selectedUsecase ? (
                          <>
                            <Badge variant="brand">{selectedUsecase.spec.software.kind}</Badge>
                            <Badge variant="outline">v{selectedUsecase.version}</Badge>
                            <Badge variant="outline">
                              {t("jobs.usecase.inputCount", {
                                count: usecaseInputCount(selectedUsecase),
                                defaultValue: "{{count}} inputs",
                              })}
                            </Badge>
                            <Badge variant="outline">
                              {t("jobs.usecase.outputCount", {
                                count: selectedUsecase.spec.filesomeOutputs?.length ?? 0,
                                defaultValue: "{{count}} outputs",
                              })}
                            </Badge>
                          </>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full sm:w-auto"
                          onClick={() => setUsecasePickerOpen(true)}
                          data-testid="submit-usecase-picker-open"
                        >
                          <SlidersHorizontal />
                          {selectedUsecase
                            ? t("jobs.usecase.changeUsecase", {
                                defaultValue: "Change usecase",
                              })
                            : t("jobs.usecase.chooseUsecase", {
                                defaultValue: "Choose usecase",
                              })}
                        </Button>
                      </div>
                    </div>
                    {selectedUsecase?.description ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {selectedUsecase.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-3 rounded-md border border-border bg-card p-3">
                    {selectedUsecase ? (
                      <div className="grid gap-3">
                        {visibleInputSlots(selectedUsecase).map((slot) => {
                          const value = usecaseInputs[slot.descriptor];
                          const batch = isBatchFileSlot(selectedUsecase, slot.descriptor);
                          const fieldId = usecaseFieldId(slot.descriptor);
                          const files = Array.isArray(value)
                            ? value
                            : value && typeof value === "object"
                              ? [value]
                              : [];
                          return (
                            <div key={slot.descriptor} className="space-y-1">
                              <label
                                htmlFor={fieldId}
                                className="text-xs font-medium uppercase text-muted-foreground"
                              >
                                {slot.descriptor}
                              </label>
                              {slot.kind === "Text" ? (
                                isStdinTextSlot(selectedUsecase, slot.descriptor) ? (
                                  <Textarea
                                    id={fieldId}
                                    rows={4}
                                    value={typeof value === "string" ? value : ""}
                                    onChange={(event) =>
                                      setTextInput(slot.descriptor, event.target.value)
                                    }
                                    className="font-mono text-xs"
                                    data-testid={`submit-usecase-input-${slot.descriptor}`}
                                  />
                                ) : (
                                  <Input
                                    id={fieldId}
                                    value={typeof value === "string" ? value : ""}
                                    onChange={(event) =>
                                      setTextInput(slot.descriptor, event.target.value)
                                    }
                                    data-testid={`submit-usecase-input-${slot.descriptor}`}
                                  />
                                )
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setPickerSlot(slot.descriptor)}
                                      id={fieldId}
                                      data-testid={`submit-usecase-file-${slot.descriptor}`}
                                    >
                                      <FilePlus2 />
                                      {batch
                                        ? t("jobs.usecase.addFile", {
                                            defaultValue: "Add file",
                                          })
                                        : t("jobs.usecase.chooseFile", {
                                            defaultValue: "Choose file",
                                          })}
                                    </Button>
                                    <span className="text-xs text-muted-foreground">
                                      {batch
                                        ? t("jobs.usecase.batchFileHint", {
                                            count: files.length,
                                            defaultValue: "{{count}} files selected",
                                          })
                                        : (files[0]?.fileMetadataName ??
                                          t("jobs.usecase.noFile", {
                                            defaultValue: "No file selected",
                                          }))}
                                    </span>
                                  </div>
                                  {files.length > 0 ? (
                                    <div className="space-y-1">
                                      {files.map((file) => (
                                        <div
                                          key={file.fileMetadataId}
                                          className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1"
                                        >
                                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                            {file.fileMetadataName}
                                          </span>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            onClick={() =>
                                              removeFileInput(slot.descriptor, file.fileMetadataId)
                                            }
                                            aria-label={t("jobs.usecase.removeFile", {
                                              defaultValue: "Remove file",
                                            })}
                                          >
                                            <X />
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {datasetInputs(selectedUsecase).map((input) => (
                          <div className="space-y-1" key={input.descriptor}>
                            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                              <span>{input.descriptor}</span>
                              {input.required ? (
                                <Badge variant="outline">{t("jobs.usecase.required")}</Badge>
                              ) : null}
                            </div>
                            <DatasetInputPicker
                              descriptor={input.descriptor}
                              onChange={(next) =>
                                setUsecaseDataInputs((current) => {
                                  if (next) return { ...current, [input.descriptor]: next };
                                  const updated = { ...current };
                                  delete updated[input.descriptor];
                                  return updated;
                                })
                              }
                              onValidityChange={(valid) =>
                                setUsecaseDataInputValidity((current) => {
                                  if (current[input.descriptor] === valid) return current;
                                  return { ...current, [input.descriptor]: valid };
                                })
                              }
                              activeOrganizationId={activeOrganizationId}
                              usecaseId={selectedUsecase.id}
                              value={asDatasetInput(usecaseDataInputs[input.descriptor])}
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
                        {t("jobs.usecase.empty", { defaultValue: "No usecase selected" })}
                      </div>
                    )}
                  </div>
                </div>
                <UsecasePickerDialog
                  error={!!usecasesQ.error}
                  loading={usecasesQ.isLoading}
                  onOpenChange={setUsecasePickerOpen}
                  onSelect={setSelectedUsecaseId}
                  open={usecasePickerOpen}
                  packages={selectableUsecases}
                  selectedId={selectedUsecaseId}
                />
              </TabsContent>
              <TabsContent value="command" className="space-y-4 pt-3">
                <div className="block space-y-1">
                  <label
                    htmlFor="submit-job-command-input"
                    className="text-xs font-medium uppercase text-muted-foreground"
                  >
                    {t("jobs.commandLabel")}
                  </label>
                  <Textarea
                    id="submit-job-command-input"
                    rows={3}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    className="font-mono text-xs"
                    data-testid="submit-job-command"
                  />
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium uppercase text-muted-foreground">
                        {t("jobs.commandWorkdir.section", {
                          defaultValue: "Working directory",
                        })}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {commandWorkdirEntries.length > 0
                          ? t("jobs.commandWorkdir.summary", {
                              count: commandWorkdirEntries.length,
                              size: fmtBytes(commandWorkdirSize),
                              defaultValue: "{{count}} files · {{size}}",
                            })
                          : commandWorkdirFolderTotal > 0
                            ? t("jobs.commandWorkdir.folderSummary", {
                                count: commandWorkdirFolderTotal,
                                defaultValue: "{{count}} folders",
                              })
                            : t("jobs.commandWorkdir.previewEmpty", {
                                defaultValue: "No input files staged.",
                              })}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setCommandWorkdirOpen(true)}
                      data-testid="submit-command-workdir-open"
                    >
                      <FilePlus2 />
                      {t("jobs.commandWorkdir.manageFiles", {
                        defaultValue: "Manage files",
                      })}
                    </Button>
                  </div>
                  {commandWorkdirEntries.length > 0 || commandWorkdirFolders.length > 0 ? (
                    <CommandWorkdirPreviewTree
                      entries={commandWorkdirEntries}
                      folders={commandWorkdirFolders}
                      t={t}
                    />
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>
            <div className="block space-y-1">
              <label
                htmlFor="submit-job-name-input"
                className="text-xs font-medium uppercase text-muted-foreground"
              >
                {t("jobs.nameLabel")}
              </label>
              <Input
                id="submit-job-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("jobs.namePlaceholder")}
                data-testid="submit-job-name"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="block space-y-1">
                <label
                  htmlFor="submit-job-cpus-input"
                  className="text-xs font-medium uppercase text-muted-foreground"
                >
                  {t("jobs.cpusLabel")}
                </label>
                <Input
                  id="submit-job-cpus-input"
                  type="number"
                  min={1}
                  value={cpus}
                  onChange={(e) => setCpus(Math.max(1, Number(e.target.value) || 1))}
                  data-testid="submit-job-cpus"
                />
              </div>
              <div className="block space-y-1">
                <label
                  htmlFor="submit-job-memory-input"
                  className="text-xs font-medium uppercase text-muted-foreground"
                >
                  {t("jobs.memoryLabel")}
                </label>
                <Input
                  id="submit-job-memory-input"
                  type="number"
                  min={64}
                  value={memMb}
                  onChange={(e) => setMemMb(Math.max(64, Number(e.target.value) || 1024))}
                  data-testid="submit-job-memory"
                />
              </div>
            </div>
            <fieldset className="min-w-0 space-y-2" data-testid="submit-job-queue">
              <legend className="text-xs font-medium uppercase text-muted-foreground">
                {t("jobs.queueLabel", { defaultValue: "Queue placement" })}
              </legend>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
                <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-border px-3 text-sm">
                  <input
                    type="radio"
                    name="submit-job-placement"
                    checked={placementSelection.mode === "auto"}
                    onChange={() => {
                      setPlacementSelection({ mode: "auto" });
                      setInvalidQueueId(null);
                      setQueueSubmitError(null);
                    }}
                    data-testid="submit-job-placement-auto"
                  />
                  {t("jobs.queueAuto", { defaultValue: "Auto placement" })}
                </label>
                <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-border px-3 text-sm">
                  <input
                    type="radio"
                    name="submit-job-placement"
                    checked={placementSelection.mode === "default"}
                    onChange={() => {
                      setPlacementSelection({ mode: "default", queueId: recentQueueIds.default });
                      setInvalidQueueId(null);
                      setQueueSubmitError(null);
                    }}
                    data-testid="submit-job-placement-default"
                  />
                  {t("jobs.queueSchedulerDefault", { defaultValue: "Scheduler default" })}
                </label>
                <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-border px-3 text-sm">
                  <input
                    type="radio"
                    name="submit-job-placement"
                    checked={placementSelection.mode === "named"}
                    onChange={() => {
                      setPlacementSelection({ mode: "named", queueId: recentQueueIds.named });
                      setInvalidQueueId(null);
                      setQueueSubmitError(null);
                    }}
                    data-testid="submit-job-placement-named"
                  />
                  {t("jobs.queueNamed", { defaultValue: "Named queue" })}
                </label>
              </div>
              {placementSelection.mode === "auto" ? (
                <p className="text-xs text-muted-foreground" data-testid="submit-job-queue-help">
                  {t("jobs.queueAutoHelp", {
                    defaultValue:
                      "The Server selects a suitable Agent and that scheduler's current default queue.",
                  })}
                </p>
              ) : queuesQ.isLoading ? (
                <div
                  className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground"
                  data-testid="submit-job-queue-loading"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t("common.loading")}
                </div>
              ) : queuesQ.error ? (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-status-failed"
                  data-testid="submit-job-queue-error"
                  role="alert"
                >
                  <span>
                    {t("jobs.queueLoadFailed", { defaultValue: "Queue list unavailable" })}:{" "}
                    {toUserFacingError(
                      queuesQ.error,
                      t("jobs.queueLoadFailed", { defaultValue: "Queue list unavailable" }),
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void queuesQ.refetch()}
                    data-testid="submit-job-queue-retry"
                  >
                    {t("common.retry", { defaultValue: "Retry" })}
                  </Button>
                </div>
              ) : placementSelection.mode === "default" && defaultQueues.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="submit-job-queue-empty-default"
                >
                  {t("jobs.queueDefaultEmpty", {
                    defaultValue: "No shared Scheduler default target is available.",
                  })}
                </p>
              ) : placementSelection.mode === "named" && namedQueues.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="submit-job-queue-empty-named"
                >
                  {t("jobs.queueNamedEmpty", {
                    defaultValue: "No shared Named queue target is available.",
                  })}
                </p>
              ) : (
                <select
                  id="submit-job-queue-select"
                  value={placementSelection.queueId}
                  onChange={(event) => {
                    const queueId = event.currentTarget.value;
                    const selectedMode = placementSelection.mode;
                    setPlacementSelection({ mode: selectedMode, queueId });
                    setRecentQueueIds((current) => ({ ...current, [selectedMode]: queueId }));
                    setInvalidQueueId(null);
                    setQueueSubmitError(null);
                  }}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground sm:h-9"
                  data-testid="submit-job-queue-select"
                >
                  <option value="">
                    {t("jobs.queueChoose", { defaultValue: "Choose a queue target" })}
                  </option>
                  {(placementSelection.mode === "default" ? defaultQueues : namedQueues).map(
                    (queue) => {
                      const eligibility = queueEligibility(queue);
                      const status =
                        eligibility.state === "ready"
                          ? ""
                          : ` · ${eligibility.state}${eligibility.reason ? `: ${eligibility.reason}` : ""}`;
                      const targetDescription =
                        queueTargetMode(queue) === "default"
                          ? `${queue.agentId} · ${queue.schedulerType} · ${queue.resolvedQueueName ?? t("jobs.queueUnresolved", { defaultValue: "unresolved" })}`
                          : `${queue.agentId} · ${queue.schedulerType} · ${queue.queueName ?? ""}${queue.qos ? ` / ${queue.qos}` : ""}`;
                      return (
                        <option key={queue.queueId} value={queue.queueId}>
                          {queue.name} · {targetDescription}
                          {status}
                        </option>
                      );
                    },
                  )}
                </select>
              )}
              {!queuesQ.isLoading && !queuesQ.error && queues.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="submit-job-queue-empty">
                  {t("jobs.queueEmptyDiagnostic", {
                    defaultValue:
                      "No enabled and visible queues are available. Auto placement remains available; disabled or unauthorized queues stay hidden until a CP admin enables or shares them.",
                  })}
                </p>
              ) : null}
              {queuesQ.error && placementSelection.mode === "auto" ? (
                <p
                  className="text-xs text-status-failed"
                  data-testid="submit-job-queue-error"
                  role="alert"
                >
                  {t("jobs.queueLoadFailed", { defaultValue: "Queue list unavailable" })}:{" "}
                  {toUserFacingError(
                    queuesQ.error,
                    t("jobs.queueLoadFailed", { defaultValue: "Queue list unavailable" }),
                  )}
                </p>
              ) : null}
              {invalidQueueId ? (
                <p
                  className="text-xs text-status-failed"
                  role="alert"
                  data-testid="submit-job-queue-invalid"
                >
                  {t("jobs.queueOriginalUnavailable", {
                    defaultValue:
                      "Your original queue selection is no longer available. Choose a new target or Auto placement.",
                  })}
                </p>
              ) : null}
              {selectedQueueEligibility && selectedQueueEligibility.state !== "ready" ? (
                <p
                  className={
                    selectedQueueEligibility.state === "blocked"
                      ? "text-xs text-status-failed"
                      : "text-xs text-muted-foreground"
                  }
                  role={selectedQueueEligibility.state === "blocked" ? "alert" : undefined}
                  data-testid="submit-job-queue-eligibility"
                >
                  {t(`jobs.queueEligibility.${selectedQueueEligibility.state}`, {
                    defaultValue: selectedQueueEligibility.reason ?? selectedQueueEligibility.state,
                  })}
                </p>
              ) : null}
              {queueSubmitError ? (
                <p
                  className="text-xs text-status-failed"
                  role="alert"
                  data-testid="submit-job-queue-submit-error"
                >
                  {queueSubmitError}
                </p>
              ) : null}
            </fieldset>
            <div className="border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setPreviewOpen((v) => !v)}
                className="flex w-full items-center gap-2 text-left text-sm font-medium"
                aria-expanded={previewOpen}
                data-testid="placement-preview-toggle"
              >
                {previewOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                {t("scheduler.placement.preview.section", {
                  defaultValue: "Placement preview",
                })}
              </button>
              {previewOpen ? (
                <div className="pt-2">
                  <PlacementPreviewPanel getJobSpec={getJobSpec} canPreview={canPreview} />
                </div>
              ) : null}
            </div>
          </form>
          <PathPickerSheet
            open={!!pickerSlot}
            onOpenChange={(next) => {
              if (!next) setPickerSlot(null);
            }}
            mode="file"
            locations={["cloud"]}
            title={t("jobs.usecase.chooseInputFile", { defaultValue: "Choose input file" })}
            description={t("jobs.usecase.chooseInputFileDesc", {
              defaultValue: "Select a NetDrive file to stage into the job run directory.",
            })}
            onSelect={applyFileSelection}
          />
          <CommandWorkdirDialog
            entries={commandWorkdirEntries}
            folders={commandWorkdirFolders}
            onApply={(entries, folders) => {
              setCommandWorkdirEntries(entries);
              setCommandWorkdirFolders(folders);
            }}
            onOpenChange={setCommandWorkdirOpen}
            open={commandWorkdirOpen}
            uploadPrefix={`jobs/command-drafts/${commandDraftId}`}
          />
        </SheetBody>
        <SheetFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              draftCleared.current = true;
              clearJobSubmitDraft(draftStorageKey);
              resetForm();
              setDraftRestored(false);
              onOpenChange(false);
            }}
          >
            {t("jobs.discardDraft", { defaultValue: "Discard draft" })}
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="submit-job-form"
            disabled={busy || !canPreview}
            data-testid="submit-job-confirm"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("common.submit")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function UsecasePickerDialog({
  error,
  loading,
  onOpenChange,
  onSelect,
  open,
  packages,
  selectedId,
}: {
  error: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  open: boolean;
  packages: UsecasePackage[];
  selectedId: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [runtime, setRuntime] = useState<UsecaseRuntimeFilter>("all");
  const [input, setInput] = useState<UsecaseInputFilter>("all");
  const [software, setSoftware] = useState("");
  const filtered = useMemo(
    () =>
      packages.filter(
        (pkg) =>
          usecaseMatches(pkg, query) &&
          (runtime === "all" || pkg.spec.software.kind === runtime) &&
          matchesInputFilter(pkg, input) &&
          matchesUsecaseSoftware(pkg, software),
      ),
    [input, packages, query, runtime, software],
  );
  const choose = (pkg: UsecasePackage) => {
    onSelect(pkg.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,900px)] w-[min(calc(100vw-1rem),1120px)]"
        data-testid="submit-usecase-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t("jobs.usecase.pickerTitle", { defaultValue: "Choose usecase" })}
          </DialogTitle>
          <DialogDescription>
            {t("jobs.usecase.pickerDescription", {
              defaultValue: "Filter by runtime, input shape, and bound software.",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_160px_160px_minmax(180px,240px)]">
            <div className="relative min-w-0">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("software.usecaseSearchPlaceholder")}
                className="pl-8"
                data-testid="submit-usecase-catalog-search"
              />
            </div>
            <select
              aria-label={t("jobs.usecase.runtimeFilter", {
                defaultValue: "Runtime filter",
              })}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={runtime}
              onChange={(event) => setRuntime(event.target.value as UsecaseRuntimeFilter)}
              data-testid="submit-usecase-runtime-filter"
            >
              {RUNTIME_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {runtimeFilterLabel(t, filter)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("jobs.usecase.inputFilter", { defaultValue: "Input filter" })}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={input}
              onChange={(event) => setInput(event.target.value as UsecaseInputFilter)}
              data-testid="submit-usecase-input-filter"
            >
              {INPUT_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {inputFilterLabel(t, filter)}
                </option>
              ))}
            </select>
            <Input
              value={software}
              onChange={(event) => setSoftware(event.target.value)}
              placeholder={t("jobs.usecase.softwareFilterPlaceholder", {
                defaultValue: "Software, e.g. gromacs",
              })}
              data-testid="submit-usecase-software-filter"
            />
          </div>
          <div
            className="grid min-h-80 flex-1 auto-rows-max content-start gap-3 overflow-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="submit-usecase-catalog-grid"
          >
            {loading ? (
              <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : error ? (
              <div className="rounded-md border border-status-failed/40 bg-card p-3 text-sm text-status-failed">
                {t("software.unreachable")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
                {t("software.noMatches")}
              </div>
            ) : (
              filtered.map((pkg) => {
                const selected = pkg.id === selectedId;
                const inputLabels = Array.from(usecaseInputKinds(pkg)).map((kind) =>
                  inputFilterLabel(t, kind),
                );
                return (
                  <button
                    key={pkg.id}
                    type="button"
                    className={`grid min-h-36 min-w-0 content-between gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/30 ${
                      selected ? "border-brand ring-1 ring-brand/40" : "border-border"
                    }`}
                    onClick={() => choose(pkg)}
                    data-testid={`submit-usecase-option-${pkg.id}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                          {pkg.name}
                        </span>
                        <Badge variant={pkg.spec.software.kind === "Spack" ? "brand" : "outline"}>
                          {pkg.spec.software.kind}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {softwareSummary(pkg)}
                      </p>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                        {pkg.description ??
                          t("software.card.noDescription", {
                            defaultValue: "No description",
                          })}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Badge variant="outline">v{pkg.version}</Badge>
                        <Badge variant="outline">
                          {t("jobs.usecase.inputCount", {
                            count: usecaseInputCount(pkg),
                            defaultValue: "{{count}} inputs",
                          })}
                        </Badge>
                        <Badge variant="outline">
                          {t("jobs.usecase.outputCount", {
                            count: pkg.spec.filesomeOutputs?.length ?? 0,
                            defaultValue: "{{count}} outputs",
                          })}
                        </Badge>
                        {inputLabels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-end text-xs">
                      {selected ? (
                        <span className="inline-flex items-center gap-1 font-medium text-brand">
                          <Check className="h-3.5 w-3.5" />
                          {t("software.manage.selected", { defaultValue: "Selected" })}
                        </span>
                      ) : (
                        <span className="font-medium text-brand">
                          {t("software.manage.choose", { defaultValue: "Choose" })}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
