import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LocalWorkflowRunner,
  LocalWorkflowRunRecord,
  WorkflowRunReader,
} from "@kuintessence/agent/embedded";
import { extractRunGraph, workflowDsl } from "@kuintessence/shared";
import { parse as parseYaml } from "yaml";
import type { LocalWorkflowSupport } from "./local";
import type {
  TuiJobStatus,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
  TuiWorkflowStep,
} from "./types";

/** User shown as the submitter for locally-run workflows (no Server identity). */
const LOCAL_USER = "local";

/** Map a run-store status string ("running" | "succeeded" | "failed") onto the
 *  TUI's closed status palette. Mirrors the remote backend's normalisation. */
function toTuiStatus(raw: string): TuiJobStatus {
  switch (raw.toLowerCase()) {
    case "queued":
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Use node results when available; otherwise only display nodes from the run graph. */
function toSteps(record: LocalWorkflowRunRecord): TuiWorkflowStep[] {
  if (record.result) {
    const { result } = record;
    return Object.entries(result.status).map(([nodeId, status]) => {
      const values = result.values[nodeId]?.values ?? {};
      const info = Object.keys(values).length > 0 ? JSON.stringify(values) : undefined;
      return { id: nodeId, status, info };
    });
  }
  return (record.graph?.nodes ?? []).map((node) => {
    const jobId = record.stepJobs[node.id];
    return { id: node.id, status: "unknown", info: jobId ? `job ${jobId}` : undefined };
  });
}

/** Map a decoded run-store record onto the TUI's workflow detail shape. */
function toDetail(record: LocalWorkflowRunRecord): TuiWorkflowDetail {
  return {
    id: record.runId,
    name: record.name,
    status: toTuiStatus(record.status),
    description: record.description ?? undefined,
    steps: toSteps(record),
    result: record.result,
    graph: record.graph,
    stepJobs: record.stepJobs,
  };
}

/** Status shown for a spec that has never been run: nothing has executed yet, so
 *  the run reads as queued and every step is pending. */
const PREVIEW_STEP_STATUS = "pending";

/** Build a "not-yet-run" detail straight from a parsed workflow spec: one step per
 *  node, all `pending`. The id is the spec file name (the row's id), so the
 *  detail view stays addressable even before the first run. */
function previewDetailFromSpec(idOrName: string, parsed: ParsedWorkflowFile): TuiWorkflowDetail {
  const steps: TuiWorkflowStep[] = parsed.spec.spec.nodeDrafts.map((node) => ({
    id: node.id,
    status: PREVIEW_STEP_STATUS,
  }));
  return {
    id: idOrName,
    name: parsed.spec.name ?? idOrName,
    status: "queued",
    description: parsed.spec.description ?? undefined,
    steps,
    result: {
      status: Object.fromEntries(steps.map((step) => [step.id, "Pending"])),
      values: {},
    },
    graph: extractRunGraph(parsed.spec),
    stepJobs: {},
  };
}

/** Filesystem seam: lets unit tests inject a fake dir + file reader instead of
 *  touching disk. Defaults wrap `node:fs` for production. */
export interface WorkflowDirFs {
  readDir(dir: string): string[];
  readFile(path: string): string;
}

const realFs: WorkflowDirFs = {
  readDir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
};

function isWorkflowFile(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

/** True when `name` is an entry of `dir` (so a stray/typo'd file name resolves to
 *  null rather than throwing on a missing-file read). Best-effort: a missing dir
 *  reads as "no specs". */
function specExists(dir: string, name: string, fs: WorkflowDirFs): boolean {
  try {
    return fs.readDir(dir).includes(name);
  } catch {
    return false;
  }
}

/**
 * Enumerate workflow specs under `dir`. The file name is the stable id; the
 * display name comes from the parsed `name` (falling back to the file name).
 * Best-effort per file: a spec that fails schema validation is skipped rather than
 * failing the whole listing — a broken file must not blank the pane. Status is
 * "unknown" (these are runnable specs, not past runs).
 */
export function listWorkflowDir(dir: string, fs: WorkflowDirFs = realFs): TuiWorkflowRun[] {
  let names: string[];
  try {
    names = fs.readDir(dir).filter(isWorkflowFile).sort();
  } catch {
    return [];
  }
  const runs: TuiWorkflowRun[] = [];
  for (const file of names) {
    const parsed = tryParseWorkflowFile(fs.readFile(join(dir, file)));
    if (parsed) {
      runs.push({ id: file, name: parsed.spec.name ?? file, status: "unknown" });
    }
  }
  return runs;
}

/** A parsed workflow file: opaque usecase ids resolved at run time via the
 *  package catalog. */
type ParsedWorkflowFile = { spec: workflowDsl.Workflow };

/** Parse a workflow file and reject documents that fail schema validation. */
function parseWorkflowFile(text: string): ParsedWorkflowFile {
  const raw: unknown = parseYaml(text);
  const result = workflowDsl.WorkflowSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Not a valid workflow: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return { spec: result.data };
}

/** Best-effort variant of {@link parseWorkflowFile}: returns undefined instead
 *  of throwing, so a single bad file never blanks the listing. */
function tryParseWorkflowFile(text: string): ParsedWorkflowFile | undefined {
  try {
    return parseWorkflowFile(text);
  } catch {
    return undefined;
  }
}

/**
 * Build the {@link LocalWorkflowSupport} surface for {@link LocalBackend} over a
 * workflows directory and an embedded {@link LocalWorkflowRunner}. `submit`
 * resolves the id (file name) to a spec under `dir`, validates the spec, and runs
 * it via `run`. It returns the run-store id the run was recorded under (so the
 * detail view can read it back). `getDetail` reads a recorded run back via the
 * injected {@link WorkflowRunReader}. The injected runner already carries the
 * package catalog + launcher, so this layer stays fs/parse only.
 */
export function createLocalWorkflowSupport(
  dir: string,
  runner: LocalWorkflowRunner,
  reader: WorkflowRunReader,
  fs: WorkflowDirFs = realFs,
): LocalWorkflowSupport {
  return {
    async list(): Promise<TuiWorkflowRun[]> {
      return listWorkflowDir(dir, fs);
    },
    async submit(idOrName: string): Promise<TuiSubmitResult> {
      const parsed = parseWorkflowFile(fs.readFile(join(dir, idOrName)));
      const { runId } = await runner.run(parsed.spec, LOCAL_USER);
      return { id: runId, name: parsed.spec.name ?? idOrName };
    },
    async getDetail(idOrSpec: string): Promise<TuiWorkflowDetail | null> {
      // 1. A recorded run id resolves directly to its (terminal or active) detail.
      const record = await reader.getRun(idOrSpec);
      if (record) return toDetail(record);

      // 2. Otherwise treat the id as a spec file name under `dir`. A spec that is
      //    not a workflow file present on disk, or that fails schema validation, is
      //    unknown → null (LocalBackend surfaces the not-found).
      if (!isWorkflowFile(idOrSpec) || !specExists(dir, idOrSpec, fs)) return null;
      const parsed = tryParseWorkflowFile(fs.readFile(join(dir, idOrSpec)));
      if (!parsed) return null;

      // 3. The latest recorded run whose name matches the spec (listRuns is
      //    newest-first) wins; absent any run, fall back to a pending preview.
      const runs = await reader.listRuns();
      const latest = runs.find((r) => r.name === parsed.spec.name);
      if (latest) {
        const latestRecord = await reader.getRun(latest.runId);
        if (latestRecord) return toDetail(latestRecord);
      }
      return previewDetailFromSpec(idOrSpec, parsed);
    },
  };
}
