import {
  type JobDataInputs,
  type JobSubmit,
  type QueueRegistryView,
  QueueRegistryViewSchema,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FilePlus2,
  FlaskConical,
  Loader2,
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
  queueDisplayName,
  queueEligibility,
  queueTargetMode,
} from "../../lib/queue-selection";
import { listUsecasePackages } from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { type PathPickerSelection, PathPickerSheet } from "../files/PathPickerSheet";
import { fmtBytes } from "../files/path-picker-utils";
import { PlacementPreviewPanel } from "../scheduler";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { ResourceSelectField } from "../ui/resource-select-field";
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
import {
  CommandWorkdirPreviewTree,
  commandWorkdirBytes,
  commandWorkdirFolderCount,
} from "./CommandWorkdirPreviewTree";
import { asDatasetInput, DatasetInputPicker } from "./DatasetInputPicker";
import {
  datasetInputs,
  hasUnboundInputs,
  isBatchFileSlot,
  isDomainUsecase,
  isStdinTextSlot,
  softwareSummary,
  type UsecaseInputs,
  usecaseFieldId,
  usecaseInputCount,
  usecaseReady,
  validTextInput,
  visibleInputSlots,
} from "./job-usecase-inputs";
import { UsecasePickerDialog } from "./UsecasePickerDialog";

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

const DEFAULT_COMMAND = 'echo "hello from kq"';

interface MaterializeResp {
  job: JobSubmit;
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

function commandInputStaging(
  entries: CommandWorkdirEntry[],
): NonNullable<JobSubmit["inputStaging"]> {
  return entries.map((entry) => ({
    fileMetadataId: entry.fileMetadataId,
    stagePath: entry.stagePath.trim(),
  }));
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
  const queueErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (queueSubmitError) queueErrorRef.current?.focus();
  }, [queueSubmitError]);
  const [busy, setBusy] = useState(false);
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
    const pkg = selectableUsecases.find((item) => item.id === selectedUsecaseId);
    const defaults: UsecaseInputs = {};
    for (const input of pkg?.spec.inputs ?? []) {
      if (
        ["string", "number", "boolean"].includes(typeof input.default) &&
        !["File", "FileBatch", "Dataset"].includes(input.type)
      )
        defaults[input.descriptor] = String(input.default);
    }
    setUsecaseInputs(defaults);
    setUsecaseDataInputs({});
    setUsecaseDataInputValidity({});
  }, [
    selectableUsecases,
    selectedUsecaseId,
    selectedUsecaseName,
    selectedUsecaseSignature,
    usecaseAutoNames,
  ]);

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
      inputs: Object.fromEntries(
        visibleInputSlots(selectedUsecase).map((slot) => [
          slot.descriptor,
          usecaseInputs[slot.descriptor] ?? "",
        ]),
      ),
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
    setQueueSubmitError(null);
    setBusy(true);
    const receipt = { id: `submit-job-${draftStorageKey ?? "local"}` };
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
      toast.success(t("jobs.submitted", { name: r.name, id: r.id.slice(0, 8) }), receipt);
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
      } else {
        toast.error(toUserFacingError(err, t("jobs.submitFailed")), receipt);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="submit-job-dialog" width="max-w-4xl">
        <SheetHeader>
          <SheetTitle>{t("jobs.submitJobTitle")}</SheetTitle>
          <SheetDescription className="sr-only">{t("jobs.submitJobDesc")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id="submit-job-form" onSubmit={onSubmit} className="space-y-4">
            {draftRestored ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
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
                  <section
                    className="border-border p-3"
                    aria-label={t("jobs.usecase.selected", { defaultValue: "Selected usecase" })}
                  >
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
                    {selectedUsecase ? (
                      <div className="mt-3 grid gap-3 border-t border-border pt-3">
                        {visibleInputSlots(selectedUsecase).map((slot) => {
                          const value = usecaseInputs[slot.descriptor];
                          const batch = isBatchFileSlot(selectedUsecase, slot.descriptor);
                          const fieldId = usecaseFieldId(slot.descriptor);
                          const contract = selectedUsecase.spec.inputs?.find(
                            (input) => input.descriptor === slot.descriptor,
                          );
                          const required = contract?.required ?? true;
                          const textValue = typeof value === "string" ? value : "";
                          const invalid =
                            slot.kind === "Text" &&
                            textValue !== "" &&
                            !validTextInput(textValue, contract);
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
                                contract?.type === "Boolean" || contract?.type === "Enum" ? (
                                  <NativeSelect
                                    id={fieldId}
                                    required={required}
                                    value={textValue}
                                    onChange={(event) =>
                                      setTextInput(slot.descriptor, event.target.value)
                                    }
                                    data-testid={`submit-usecase-input-${slot.descriptor}`}
                                  >
                                    <option value="">{t("ui.choose")}</option>
                                    {(contract.type === "Boolean"
                                      ? ["true", "false"]
                                      : (contract.enum ?? [])
                                    ).map((option) => (
                                      <option key={option} value={option}>
                                        {contract.type === "Boolean"
                                          ? t(`jobs.usecase.boolean.${option}`)
                                          : option}
                                      </option>
                                    ))}
                                  </NativeSelect>
                                ) : isStdinTextSlot(selectedUsecase, slot.descriptor) ? (
                                  <Textarea
                                    id={fieldId}
                                    rows={4}
                                    required={required}
                                    aria-invalid={invalid || undefined}
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
                                    required={required}
                                    type={
                                      contract?.type === "Integer" || contract?.type === "Number"
                                        ? "number"
                                        : "text"
                                    }
                                    step={
                                      contract?.type === "Integer"
                                        ? 1
                                        : contract?.type === "Number"
                                          ? "any"
                                          : undefined
                                    }
                                    min={contract?.minimum}
                                    max={contract?.maximum}
                                    aria-invalid={invalid || undefined}
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
                                    {(batch || files.length === 0) && (
                                      <span className="text-xs text-muted-foreground">
                                        {batch
                                          ? t("jobs.usecase.batchFileHint", {
                                              count: files.length,
                                              defaultValue: "{{count}} files selected",
                                            })
                                          : t("jobs.usecase.noFile", {
                                              defaultValue: "No file selected",
                                            })}
                                      </span>
                                    )}
                                  </div>
                                  {files.length > 0 ? (
                                    <div className="space-y-1">
                                      {files.map((file) => (
                                        <div
                                          key={file.fileMetadataId}
                                          className="flex items-center gap-2 border-border px-2 py-1"
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
                              {invalid ? (
                                <p className="text-xs text-status-failed" role="alert">
                                  {t("jobs.usecase.invalidInput")}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                        {usecaseInputCount(selectedUsecase) === 0 ? (
                          <p
                            className="text-sm text-muted-foreground"
                            data-testid="submit-usecase-no-inputs"
                          >
                            {t("jobs.usecase.noInputs")}
                          </p>
                        ) : null}
                        {hasUnboundInputs(selectedUsecase) ? (
                          <p className="text-sm text-status-failed" role="alert">
                            {t("jobs.usecase.unboundInputs")}
                          </p>
                        ) : null}
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
                    ) : null}
                  </section>
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
                <div className=" border-border p-3">
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
                <label className="flex min-h-11 min-w-0 items-center gap-2 border-b border-border px-3 text-sm">
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
                <label className="flex min-h-11 min-w-0 items-center gap-2 border-b border-border px-3 text-sm">
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
                <label className="flex min-h-11 min-w-0 items-center gap-2 border-b border-border px-3 text-sm">
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
                  className="flex min-h-11 items-center gap-2 border-border px-3 text-sm text-muted-foreground"
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
                <ResourceSelectField
                  resourceType="agents"
                  recent
                  expandable
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
                  className="h-11 w-full sm:h-9"
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
                          {queueDisplayName(queue)}
                          {queue.federation
                            ? ` · ${queue.queueName ?? ""}`
                            : ` · ${targetDescription}`}
                          {status}
                        </option>
                      );
                    },
                  )}
                </ResourceSelectField>
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
                  ref={queueErrorRef}
                  tabIndex={-1}
                  data-testid="submit-job-queue-submit-error"
                >
                  {queueSubmitError}
                </p>
              ) : null}
            </fieldset>
            <div className="border-t border-border pt-3">
              <PlacementPreviewPanel getJobSpec={getJobSpec} canPreview={canPreview} />
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
        <SheetFooter className="justify-end gap-2 [&>button]:flex-initial [&>button]:px-3">
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
