import {
  type JobDataInputs,
  JobDataInputsSchema,
  type JobUsecaseInputs,
  JobUsecaseInputsSchema,
  StagePathSchema,
} from "@kuintessence/shared/browser";
import type { PlacementSelection } from "./queue-selection";

const DRAFT_VERSION = 2;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_KEY_PREFIX = "kq.job-submit-draft";

export type JobSubmitDraftMode = "command" | "usecase";

export interface JobSubmitDraftWorkdirEntry {
  id: string;
  source: "cloud" | "upload";
  fileMetadataId: string;
  fileMetadataName: string;
  cloudPath: string;
  stagePath: string;
  size: number | null;
}

export interface JobSubmitDraft {
  mode: JobSubmitDraftMode;
  name: string;
  command: string;
  cpus: number;
  memMb: number;
  placementSelection: PlacementSelection;
  legacyQueueId?: string;
  selectedUsecaseId: string | null;
  usecaseInputs: JobUsecaseInputs;
  usecaseDataInputs: JobDataInputs;
  commandWorkdirEntries: JobSubmitDraftWorkdirEntry[];
  commandWorkdirFolders: string[];
}

interface StoredJobSubmitDraft extends JobSubmitDraft {
  version: number;
  savedAt: number;
}

const SENSITIVE_INPUT_DESCRIPTOR = /(token|secret|password|credential|api[_-]?key)/i;
const PRESIGNED_URL_MARKER = /(?:[?&](?:x-amz-|signature=|token=)|[?&]se=)/i;
const SENSITIVE_COMMAND_MARKER =
  /(?:--(?:token|secret|password|credential|api[_-]?key)\b|(?:token|secret|password|credential|api[_-]?key)\s*=)/i;

function containsPersistableSecret(value: string): boolean {
  return PRESIGNED_URL_MARKER.test(value) || SENSITIVE_COMMAND_MARKER.test(value);
}

function hasSensitiveDraftValue(draft: JobSubmitDraft): boolean {
  if (containsPersistableSecret(draft.command)) return true;
  return Object.entries(draft.usecaseInputs).some(
    ([descriptor, value]) =>
      SENSITIVE_INPUT_DESCRIPTOR.test(descriptor) ||
      (typeof value === "string" && containsPersistableSecret(value)),
  );
}

export function jobSubmitDraftStorageKey(input: {
  email: string | null;
  organizationId: string | null;
}): string | null {
  if (!input.email) return null;
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(input.email)}:${input.organizationId ?? "personal"}`;
}

export function loadJobSubmitDraft(key: string | null): JobSubmitDraft | null {
  if (!key || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const stored = parseStoredDraft(JSON.parse(raw) as unknown);
    if (!stored || Date.now() - stored.savedAt > DRAFT_TTL_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return {
      mode: stored.mode,
      name: stored.name,
      command: stored.command,
      cpus: stored.cpus,
      memMb: stored.memMb,
      placementSelection: stored.placementSelection,
      ...(stored.legacyQueueId ? { legacyQueueId: stored.legacyQueueId } : {}),
      selectedUsecaseId: stored.selectedUsecaseId,
      usecaseInputs: stored.usecaseInputs,
      usecaseDataInputs: stored.usecaseDataInputs,
      commandWorkdirEntries: stored.commandWorkdirEntries,
      commandWorkdirFolders: stored.commandWorkdirFolders,
    };
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}

export function saveJobSubmitDraft(key: string | null, draft: JobSubmitDraft): void {
  if (!key || typeof sessionStorage === "undefined") return;
  const parsed = parseDraft(draft);
  if (!parsed || hasSensitiveDraftValue(parsed)) {
    sessionStorage.removeItem(key);
    return;
  }
  const stored: StoredJobSubmitDraft = {
    ...parsed,
    version: DRAFT_VERSION,
    savedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Draft recovery is optional when browser storage is unavailable or full.
  }
}

export function clearJobSubmitDraft(key: string | null): void {
  if (!key || typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(key);
}

function parseStoredDraft(value: unknown): StoredJobSubmitDraft | null {
  if (!isRecord(value) || !isFiniteNumber(value.savedAt)) {
    return null;
  }
  if (value.version === DRAFT_VERSION) {
    const draft = parseDraft(value);
    return draft ? { ...draft, version: DRAFT_VERSION, savedAt: value.savedAt } : null;
  }
  if (value.version !== 1) return null;
  const legacy = parseLegacyDraft(value);
  return legacy ? { ...legacy, version: DRAFT_VERSION, savedAt: value.savedAt } : null;
}

function parseDraft(value: unknown): JobSubmitDraft | null {
  if (!isRecord(value)) return null;
  if (
    (value.mode !== "command" && value.mode !== "usecase") ||
    !isStringWithin(value.name, 255) ||
    !isStringWithin(value.command, 100_000) ||
    !isPositiveInteger(value.cpus) ||
    !isPositiveInteger(value.memMb) ||
    !isPlacementSelection(value.placementSelection) ||
    !(value.selectedUsecaseId === null || isStringWithin(value.selectedUsecaseId, 255)) ||
    !Array.isArray(value.commandWorkdirEntries) ||
    !value.commandWorkdirEntries.every(isWorkdirEntry) ||
    !Array.isArray(value.commandWorkdirFolders) ||
    !value.commandWorkdirFolders.every(isStagePath)
  ) {
    return null;
  }
  const usecaseInputs = JobUsecaseInputsSchema.safeParse(value.usecaseInputs);
  const usecaseDataInputs = JobDataInputsSchema.safeParse(value.usecaseDataInputs);
  if (!usecaseInputs.success || !usecaseDataInputs.success) return null;
  return {
    mode: value.mode,
    name: value.name,
    command: value.command,
    cpus: value.cpus,
    memMb: value.memMb,
    placementSelection: value.placementSelection,
    ...(isStringWithin(value.legacyQueueId, 255) && value.legacyQueueId
      ? { legacyQueueId: value.legacyQueueId }
      : {}),
    selectedUsecaseId: value.selectedUsecaseId,
    usecaseInputs: usecaseInputs.data,
    usecaseDataInputs: usecaseDataInputs.data,
    commandWorkdirEntries: value.commandWorkdirEntries,
    commandWorkdirFolders: value.commandWorkdirFolders,
  };
}

function parseLegacyDraft(value: Record<string, unknown>): JobSubmitDraft | null {
  const queueId = value.queueId;
  if (!isStringWithin(queueId, 255)) return null;
  const parsed = parseDraft({
    ...value,
    placementSelection: queueId ? { mode: "named", queueId } : { mode: "auto" },
    ...(queueId ? { legacyQueueId: queueId } : {}),
  });
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isStringWithin(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isPlacementSelection(value: unknown): value is PlacementSelection {
  if (!isRecord(value)) return false;
  if (value.mode === "auto") return true;
  return (value.mode === "default" || value.mode === "named") && isStringWithin(value.queueId, 255);
}

function isStagePath(value: unknown): value is string {
  return StagePathSchema.safeParse(value).success;
}

function isWorkdirEntry(value: unknown): value is JobSubmitDraftWorkdirEntry {
  if (!isRecord(value)) return false;
  return (
    isStringWithin(value.id, 255) &&
    (value.source === "cloud" || value.source === "upload") &&
    isStringWithin(value.fileMetadataId, 255) &&
    isStringWithin(value.fileMetadataName, 255) &&
    isStringWithin(value.cloudPath, 2_048) &&
    isStagePath(value.stagePath) &&
    (value.size === null || (isFiniteNumber(value.size) && value.size >= 0))
  );
}
