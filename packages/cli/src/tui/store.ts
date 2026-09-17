import type {
  TuiAgent,
  TuiBackendCapabilities,
  TuiJob,
  TuiJobDetail,
  TuiJobStatus,
  TuiSoftware,
  TuiSoftwarePage,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "./backend/types";

export type PaneId = "jobs" | "workflows" | "agents" | "metrics" | "software";

export const PANE_ORDER: readonly PaneId[] = ["jobs", "workflows", "agents", "metrics", "software"];

/** List ordering applied after filtering. "default" keeps backend order. */
export type SortKey = "default" | "name" | "status";

const SORT_CYCLE: readonly SortKey[] = ["default", "name", "status"];

export function nextSortKey(key: SortKey): SortKey {
  const i = SORT_CYCLE.indexOf(key);
  return SORT_CYCLE[(i + 1) % SORT_CYCLE.length] ?? "default";
}

/** The submit-from-file prompt. `open` overlays a single-line path input that
 *  captures keystrokes until enter (submit) or esc (cancel). */
export interface SubmitForm {
  open: boolean;
  path: string;
  submitting: boolean;
}

/** A y/n confirmation for a destructive action (currently job cancel). `open`
 *  overlays a prompt that captures keys until y (confirm) or n/esc (dismiss). */
export interface ConfirmPrompt {
  open: boolean;
  jobId: string;
  jobName: string;
  /** When set, this is a bulk cancel of N marked jobs (jobId/jobName unused). */
  bulkCount?: number;
}

export interface TuiState {
  pane: PaneId;
  view: "list" | "detail" | "logs";
  jobs: TuiJob[];
  workflows: TuiWorkflowRun[];
  agents: TuiAgent[];
  software: TuiSoftware[];
  softwarePage: Omit<TuiSoftwarePage, "items"> & { serverFiltered: boolean };
  softwareQuery: string;
  selectedIndex: number;
  /** Ids of jobs marked for a bulk action (k9s-style multi-select). Toggled
   *  with space; cleared on pane switch. Empties unless the user is marking. */
  marked: ReadonlySet<string>;
  /** Id of the item whose detail/logs view is open. Pins the detail to that
   *  item so a background poll reordering/dropping the list can't make the
   *  detail silently show a different row. Undefined in list view. */
  detailId?: string;
  loading: boolean;
  error?: string;
  /** Transient one-line feedback for the footer (e.g. "Cancelled job 12345"). */
  notice?: string;
  form: SubmitForm;
  confirm: ConfirmPrompt;
  /** Whether the `?` keybinding-help overlay is shown. */
  helpOpen: boolean;
  /** Case-insensitive substring filter applied to the active list (k9s-style).
   *  Empty = no filter. */
  filter: string;
  /** Whether the `/` filter input is currently capturing keystrokes. */
  filtering: boolean;
  /** Active list ordering (applied after the filter). */
  sortKey: SortKey;
  /** Fetched enriched detail for the selected job (detail view). `live` flips
   *  true once a WS status push has been applied. */
  jobDetail: { loading: boolean; error?: string; data?: TuiJobDetail; live?: boolean };
  /** Fetched step/node tree for the selected workflow run (detail view). */
  wfDetail: { loading: boolean; error?: string; data?: TuiWorkflowDetail };
  /** Fetched stdout/stderr tail for the selected job (logs view). `following`
   *  re-tails on an interval (poll-based follow). `scroll` is the number of
   *  lines the view is offset *up* from the bottom (0 = pinned to the tail).
   *  `search` greps the buffer (case-insensitive); empty = show all lines. */
  logs: {
    loading: boolean;
    error?: string;
    text: string;
    following: boolean;
    scroll: number;
    search: string;
  };
}

export type TuiAction =
  | { type: "loading" }
  | { type: "jobsLoaded"; jobs: TuiJob[] }
  | { type: "workflowsLoaded"; workflows: TuiWorkflowRun[] }
  | { type: "agentsLoaded"; agents: TuiAgent[] }
  | { type: "softwareLoaded"; page: TuiSoftwarePage; serverFiltered: boolean }
  | { type: "loadError"; error: string }
  | { type: "selectNext" }
  | { type: "selectPrev" }
  | { type: "selectFirst" }
  | { type: "selectLast" }
  | { type: "pageDown"; size: number }
  | { type: "pageUp"; size: number }
  | { type: "setPane"; pane: PaneId }
  | { type: "openDetail" }
  | { type: "closeDetail" }
  | { type: "notice"; message: string }
  | { type: "clearNotice" }
  | { type: "formOpen" }
  | { type: "formInput"; text: string }
  | { type: "formBackspace" }
  | { type: "formClose" }
  | { type: "formSubmitting" }
  | { type: "confirmCancelOpen"; jobId: string; jobName: string }
  | { type: "confirmBulkCancelOpen"; count: number }
  | { type: "confirmClose" }
  | { type: "helpToggle" }
  | { type: "helpClose" }
  | { type: "filterOpen" }
  | { type: "filterInput"; text: string }
  | { type: "filterBackspace" }
  | { type: "filterCommit" }
  | { type: "filterClear" }
  | { type: "jobDetailLoading" }
  | { type: "jobDetailLoaded"; detail: TuiJobDetail }
  | { type: "jobDetailError"; error: string }
  | { type: "jobStatusLive"; status: TuiJobStatus }
  | { type: "wfDetailLoading" }
  | { type: "wfDetailLoaded"; detail: TuiWorkflowDetail }
  | { type: "wfDetailError"; error: string }
  | { type: "cycleSort" }
  | { type: "toggleMark" }
  | { type: "clearMarks" }
  | { type: "openLogs" }
  | { type: "logsLoading" }
  | { type: "logsLoaded"; text: string }
  | { type: "logsError"; error: string }
  | { type: "toggleLogsFollow" }
  | { type: "logsScrollBy"; delta: number; max: number };

export function initialState(pane: PaneId = "jobs"): TuiState {
  return {
    pane,
    view: "list",
    jobs: [],
    workflows: [],
    agents: [],
    software: [],
    softwarePage: {
      page: 1,
      pageSize: 24,
      totalCount: 0,
      totalPages: 1,
      serverFiltered: false,
    },
    softwareQuery: "",
    selectedIndex: 0,
    marked: new Set(),
    loading: false,
    form: { open: false, path: "", submitting: false },
    confirm: { open: false, jobId: "", jobName: "" },
    helpOpen: false,
    filter: "",
    filtering: false,
    sortKey: "default",
    jobDetail: { loading: false },
    wfDetail: { loading: false },
    logs: { loading: false, text: "", following: false, scroll: 0, search: "" },
  };
}

function matches(filter: string, ...fields: string[]): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(needle));
}

/** Stable sort by the active key. "default" preserves backend order; "name"
 *  sorts alphabetically by the primary label; "status" groups by status. */
function sorted<T extends { status: string }>(
  items: T[],
  key: SortKey,
  nameOf: (item: T) => string,
): T[] {
  if (key === "default") return items;
  const copy = [...items];
  copy.sort((a, b) =>
    key === "name" ? nameOf(a).localeCompare(nameOf(b)) : a.status.localeCompare(b.status),
  );
  return copy;
}

/** The current pane's rows after applying the active filter, then sort.
 *  Selection bounds and panes operate on these — never the raw arrays. */
export function visibleJobs(state: TuiState): TuiJob[] {
  const filtered = state.jobs.filter((j) =>
    matches(state.filter, j.name, j.id, j.location, j.status),
  );
  return sorted(filtered, state.sortKey, (j) => j.name);
}

export function visibleWorkflows(state: TuiState): TuiWorkflowRun[] {
  const filtered = state.workflows.filter((w) => matches(state.filter, w.name, w.id, w.status));
  return sorted(filtered, state.sortKey, (w) => w.name);
}

export function visibleAgents(state: TuiState): TuiAgent[] {
  const filtered = state.agents.filter((a) =>
    matches(state.filter, a.id, a.site, a.scheduler, a.status),
  );
  return sorted(filtered, state.sortKey, (a) => a.id);
}

export function visibleSoftware(state: TuiState): TuiSoftware[] {
  const filtered = state.softwarePage.serverFiltered
    ? state.software
    : state.software.filter((s) =>
        matches(
          state.filter,
          s.name,
          s.id,
          s.source,
          s.versions.join(" "),
          s.spec ?? "",
          s.lifecycle,
        ),
      );
  if (state.sortKey === "default") return filtered;
  const copy = [...filtered];
  copy.sort((a, b) =>
    state.sortKey === "name"
      ? a.name.localeCompare(b.name)
      : a.lifecycle.localeCompare(b.lifecycle),
  );
  return copy;
}

/**
 * The item a pane should show in its detail/logs view: pinned by `detailId`
 * (the item open when the view was entered) so a background poll can't swap it,
 * falling back to the current selection while no detail is pinned.
 */
export function pinnedItem<T extends { id: string }>(
  items: T[],
  detailId: string | undefined,
  selectedIndex: number,
): T | undefined {
  if (detailId) {
    const found = items.find((i) => i.id === detailId);
    if (found) return found;
  }
  return items[selectedIndex];
}

/** Id of the active pane's currently-selected row (used to pin a detail view). */
function selectedItemId(state: TuiState): string | undefined {
  switch (state.pane) {
    case "jobs":
      return visibleJobs(state)[state.selectedIndex]?.id;
    case "workflows":
      return visibleWorkflows(state)[state.selectedIndex]?.id;
    case "agents":
    case "metrics":
      return visibleAgents(state)[state.selectedIndex]?.id;
    case "software":
      return visibleSoftware(state)[state.selectedIndex]?.id;
  }
}

/** Number of visible rows in the active pane — what selection clamps against
 *  (post-filter). */
export function activeLength(state: TuiState): number {
  switch (state.pane) {
    case "jobs":
      return visibleJobs(state).length;
    case "workflows":
      return visibleWorkflows(state).length;
    case "agents":
    case "metrics":
      return visibleAgents(state).length;
    case "software":
      return visibleSoftware(state).length;
  }
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/** Keep the cursor on the same row across a background refresh: if the
 *  previously-selected item is still present, return its new index; otherwise
 *  clamp the old index into the new list. Prevents the selection from jumping
 *  to a different item when a poll reorders or drops rows (k9s behaviour). */
function preserveSelection<T extends { id: string }>(
  prevSelected: { id: string } | undefined,
  nextVisible: T[],
  prevIndex: number,
): number {
  if (prevSelected) {
    const idx = nextVisible.findIndex((item) => item.id === prevSelected.id);
    if (idx >= 0) return idx;
  }
  return clamp(prevIndex, nextVisible.length);
}

/** Pure reducer for the TUI. Every transition returns a new object; no input is
 *  mutated. Selection is always kept within the active pane's row count. The
 *  App only ever loads the active pane, so a `*Loaded` re-clamps selection. */
export function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, error: undefined };
    case "jobsLoaded": {
      const prev = visibleJobs(state)[state.selectedIndex];
      const next = { ...state, loading: false, error: undefined, jobs: action.jobs };
      return {
        ...next,
        selectedIndex: preserveSelection(prev, visibleJobs(next), state.selectedIndex),
      };
    }
    case "workflowsLoaded": {
      const prev = visibleWorkflows(state)[state.selectedIndex];
      const next = { ...state, loading: false, error: undefined, workflows: action.workflows };
      return {
        ...next,
        selectedIndex: preserveSelection(prev, visibleWorkflows(next), state.selectedIndex),
      };
    }
    case "agentsLoaded": {
      const prev = visibleAgents(state)[state.selectedIndex];
      const next = { ...state, loading: false, error: undefined, agents: action.agents };
      return {
        ...next,
        selectedIndex: preserveSelection(prev, visibleAgents(next), state.selectedIndex),
      };
    }
    case "softwareLoaded": {
      const prev = visibleSoftware(state)[state.selectedIndex];
      const { items, ...page } = action.page;
      const next = {
        ...state,
        loading: false,
        error: undefined,
        software: items,
        softwarePage: { ...page, serverFiltered: action.serverFiltered },
      };
      return {
        ...next,
        selectedIndex: preserveSelection(prev, visibleSoftware(next), state.selectedIndex),
      };
    }
    case "loadError":
      return { ...state, loading: false, error: action.error };
    case "selectNext":
      return { ...state, selectedIndex: clamp(state.selectedIndex + 1, activeLength(state)) };
    case "selectPrev":
      return { ...state, selectedIndex: clamp(state.selectedIndex - 1, activeLength(state)) };
    case "selectFirst":
      return { ...state, selectedIndex: 0 };
    case "selectLast":
      return { ...state, selectedIndex: clamp(activeLength(state) - 1, activeLength(state)) };
    case "pageDown":
      return {
        ...state,
        selectedIndex: clamp(state.selectedIndex + action.size, activeLength(state)),
      };
    case "pageUp":
      return {
        ...state,
        selectedIndex: clamp(state.selectedIndex - action.size, activeLength(state)),
      };
    case "setPane":
      return {
        ...state,
        pane: action.pane,
        view: "list",
        selectedIndex: 0,
        error: undefined,
        detailId: undefined,
        // Marks are a per-pane transient selection — clear on switch.
        marked: new Set(),
        // Filter is a per-pane transient search — clear it so switching panes
        // doesn't silently hide rows. Sort is a viewing preference; it persists.
        filter: "",
        filtering: false,
        softwareQuery: "",
        jobDetail: { loading: false },
        wfDetail: { loading: false },
        logs: { loading: false, text: "", following: false, scroll: 0, search: "" },
      };
    case "openDetail":
      return activeLength(state) > 0
        ? { ...state, view: "detail", detailId: selectedItemId(state) }
        : state;
    case "closeDetail":
      return {
        ...state,
        view: "list",
        detailId: undefined,
        jobDetail: { loading: false },
        wfDetail: { loading: false },
        logs: { loading: false, text: "", following: false, scroll: 0, search: "" },
      };
    case "notice":
      return { ...state, notice: action.message };
    case "clearNotice":
      return { ...state, notice: undefined };
    case "formOpen":
      return { ...state, form: { open: true, path: "", submitting: false } };
    case "formInput":
      if (!state.form.open || state.form.submitting) return state;
      return { ...state, form: { ...state.form, path: state.form.path + action.text } };
    case "formBackspace":
      if (!state.form.open || state.form.submitting) return state;
      return { ...state, form: { ...state.form, path: state.form.path.slice(0, -1) } };
    case "formSubmitting":
      return { ...state, form: { ...state.form, submitting: true } };
    case "formClose":
      return { ...state, form: { open: false, path: "", submitting: false } };
    case "confirmCancelOpen":
      return {
        ...state,
        confirm: { open: true, jobId: action.jobId, jobName: action.jobName },
      };
    case "confirmBulkCancelOpen":
      return {
        ...state,
        confirm: { open: true, jobId: "", jobName: "", bulkCount: action.count },
      };
    case "confirmClose":
      return { ...state, confirm: { open: false, jobId: "", jobName: "" } };
    case "helpToggle":
      return { ...state, helpOpen: !state.helpOpen };
    case "helpClose":
      return { ...state, helpOpen: false };
    case "filterOpen":
      return { ...state, filtering: true };
    case "filterInput": {
      if (!state.filtering) return state;
      // The same input drives the list filter or the log search by context.
      if (state.view === "logs") {
        return { ...state, logs: { ...state.logs, search: state.logs.search + action.text } };
      }
      return { ...state, filter: state.filter + action.text, selectedIndex: 0 };
    }
    case "filterBackspace": {
      if (!state.filtering) return state;
      if (state.view === "logs") {
        return { ...state, logs: { ...state.logs, search: state.logs.search.slice(0, -1) } };
      }
      return { ...state, filter: state.filter.slice(0, -1), selectedIndex: 0 };
    }
    case "filterCommit":
      return {
        ...state,
        filtering: false,
        softwareQuery: state.pane === "software" ? state.filter : state.softwareQuery,
        ...(state.pane === "software"
          ? { selectedIndex: 0, softwarePage: { ...state.softwarePage, page: 1 } }
          : {}),
      };
    case "filterClear":
      if (state.view === "logs") {
        return { ...state, filtering: false, logs: { ...state.logs, search: "" } };
      }
      return {
        ...state,
        filter: "",
        filtering: false,
        selectedIndex: 0,
        softwareQuery: state.pane === "software" ? "" : state.softwareQuery,
        ...(state.pane === "software" ? { softwarePage: { ...state.softwarePage, page: 1 } } : {}),
      };
    case "jobDetailLoading":
      return { ...state, jobDetail: { loading: true } };
    case "jobDetailLoaded":
      return { ...state, jobDetail: { loading: false, data: action.detail } };
    case "jobDetailError":
      return { ...state, jobDetail: { loading: false, error: action.error } };
    case "jobStatusLive": {
      // Apply a live WS push only while a job detail is open. Merge into the
      // fetched record (or seed a minimal one) and flag the view as live.
      if (state.view !== "detail" || state.pane !== "jobs") return state;
      const base = state.jobDetail.data;
      const selected = visibleJobs(state)[state.selectedIndex];
      if (!base && !selected) return state;
      const data: TuiJobDetail = base
        ? { ...base, status: action.status }
        : {
            id: selected?.id ?? "",
            name: selected?.name ?? "",
            status: action.status,
          };
      return { ...state, jobDetail: { ...state.jobDetail, data, live: true } };
    }
    case "wfDetailLoading":
      return { ...state, wfDetail: { loading: true } };
    case "wfDetailLoaded":
      return { ...state, wfDetail: { loading: false, data: action.detail } };
    case "wfDetailError":
      return { ...state, wfDetail: { loading: false, error: action.error } };
    case "cycleSort":
      return { ...state, sortKey: nextSortKey(state.sortKey), selectedIndex: 0 };
    case "toggleMark": {
      const id = selectedItemId(state);
      if (id === undefined) return state;
      const next = new Set(state.marked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...state, marked: next };
    }
    case "clearMarks":
      return state.marked.size === 0 ? state : { ...state, marked: new Set() };
    case "openLogs":
      return activeLength(state) > 0
        ? {
            ...state,
            view: "logs",
            detailId: selectedItemId(state),
            logs: { loading: false, text: "", following: false, scroll: 0, search: "" },
          }
        : state;
    case "logsLoading":
      return { ...state, logs: { ...state.logs, loading: true, error: undefined } };
    case "logsLoaded":
      return {
        ...state,
        logs: { ...state.logs, loading: false, error: undefined, text: action.text },
      };
    case "logsError":
      return { ...state, logs: { ...state.logs, loading: false, text: "", error: action.error } };
    case "toggleLogsFollow": {
      const following = !state.logs.following;
      // Re-enabling follow snaps back to the tail; pausing keeps the position.
      return {
        ...state,
        logs: { ...state.logs, following, scroll: following ? 0 : state.logs.scroll },
      };
    }
    case "logsScrollBy": {
      const scroll = clamp(state.logs.scroll + action.delta, action.max + 1);
      // Manual scroll-up pauses follow so the next re-tail can't yank the view
      // back to the bottom out from under the reader.
      const following = scroll > 0 ? false : state.logs.following;
      return { ...state, logs: { ...state.logs, scroll, following } };
    }
    default:
      return state;
  }
}

/** First pane enabled by the capabilities, in {@link PANE_ORDER}; "jobs" if
 *  somehow none are. */
export function firstEnabledPane(caps: TuiBackendCapabilities): PaneId {
  return PANE_ORDER.find((p) => isPaneEnabled(p, caps)) ?? "jobs";
}

/** The pane to open on startup: the `requested` one if it's enabled in this
 *  mode (e.g. `kq tui --pane metrics`), else the first enabled pane. A request
 *  for a Server-only pane in local mode thus degrades gracefully. */
export function resolveInitialPane(
  requested: PaneId | undefined,
  caps: TuiBackendCapabilities,
): PaneId {
  if (requested && isPaneEnabled(requested, caps)) return requested;
  return firstEnabledPane(caps);
}

/** The pane at a 1-based position in {@link PANE_ORDER} (the number-key shortcut
 *  `1`–`5`), or undefined when out of range or disabled in this mode. */
export function paneAtPosition(position: number, caps: TuiBackendCapabilities): PaneId | undefined {
  const pane = PANE_ORDER[position - 1];
  return pane && isPaneEnabled(pane, caps) ? pane : undefined;
}

/** The pane to switch to when cycling with Tab, given the enabled capabilities. */
export function nextEnabledPane(current: PaneId, caps: TuiBackendCapabilities): PaneId {
  const enabled = PANE_ORDER.filter((p) => isPaneEnabled(p, caps));
  if (enabled.length === 0) return current;
  const idx = enabled.indexOf(current);
  return enabled[(idx + 1) % enabled.length] ?? current;
}

export function isPaneEnabled(pane: PaneId, caps: TuiBackendCapabilities): boolean {
  switch (pane) {
    case "jobs":
      return caps.jobs;
    case "workflows":
      return caps.workflows;
    case "agents":
      return caps.agents;
    case "metrics":
      return caps.metrics;
    case "software":
      return caps.software;
  }
}
