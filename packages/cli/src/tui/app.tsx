import { readFileSync } from "node:fs";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { TuiBackend } from "./backend/types";
import { bulkCancelNotice, cancelEach } from "./bulk-cancel";
import { ConfirmPrompt, FilterBar, Footer, Header, HelpOverlay, SubmitForm } from "./chrome";
import { friendlyError, grepLines } from "./format";
import { Box, useApp, useInput, useStdout } from "./opentui";
import { AgentsPane } from "./panes/agents-pane";
import { JobsPane } from "./panes/jobs-pane";
import { LogsPane } from "./panes/logs-pane";
import { MetricsPane } from "./panes/metrics-pane";
import { SoftwarePane } from "./panes/software-pane";
import { WorkflowsPane } from "./panes/workflows-pane";
import {
  activeLength,
  initialState,
  isPaneEnabled,
  nextEnabledPane,
  type PaneId,
  paneAtPosition,
  pinnedItem,
  reducer,
  resolveInitialPane,
  visibleAgents,
  visibleJobs,
  visibleWorkflows,
} from "./store";
import { computeViewportRows } from "./viewport";

// Route all caught errors through the shared friendly formatter (auth failures
// become a re-login hint rather than a raw HTTP status).
const errorMessage = friendlyError;

/** Append a sample to a bounded per-id ring buffer (in place), dropping the
 *  oldest past `cap`. Skips undefined values (agent hasn't reported it). */
function pushHistory(
  map: Map<string, number[]>,
  id: string,
  value: number | undefined,
  cap: number,
) {
  if (value === undefined) return;
  const buf = map.get(id) ?? [];
  buf.push(value);
  if (buf.length > cap) buf.shift();
  map.set(id, buf);
}

export interface AppProps {
  backend: TuiBackend;
  pollMs?: number;
  /** Pane to open on startup (from `--pane`); falls back to the first enabled
   *  pane when omitted or disabled in this mode. */
  initialPane?: PaneId;
  /** Invoked when the user requests an SSH shell to an agent. The host
   *  destroys OpenTUI, runs the session, then creates a fresh renderer. */
  onSsh?: (agentId: string) => void;
}

/** Top-level TUI: header tabs + active pane + footer keybindings. Wires the
 *  pure reducer to the active backend (remote or local) with initial-load +
 *  polling of the active pane, and maps keystrokes to actions. */
export function App({ backend, pollMs = 2000, initialPane, onSsh }: AppProps) {
  const [state, dispatch] = useReducer(
    reducer,
    initialState(resolveInitialPane(initialPane, backend.capabilities)),
  );
  const { exit } = useApp();
  const { stdout } = useStdout();
  const viewportRows = computeViewportRows(stdout?.rows);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Epoch-ms of the last successful load, for the footer's freshness hint. A
  // ref (not state) because the 2s poll already re-renders, advancing the
  // displayed age without an extra timer; a stalled poll leaves it to grow.
  const lastUpdatedRef = useRef<number | undefined>(undefined);

  // Bounded per-agent CPU / queue history (most-recent last) accumulated across
  // polls, for the Metrics pane's trend sparklines. Refs, not reducer state:
  // poll-derived telemetry, and the 2s poll already re-renders.
  const cpuHistoryRef = useRef<Map<string, number[]>>(new Map());
  const memHistoryRef = useRef<Map<string, number[]>>(new Map());
  const queueHistoryRef = useRef<Map<string, number[]>>(new Map());
  const softwareRequestRef = useRef(0);
  const softwareInFlightRef = useRef<{
    id: number;
    page: number;
    pageSize: number;
    query: string;
  } | null>(null);
  const HISTORY_LEN = 24;

  const load = useCallback(
    async (paneArg?: PaneId, softwareRequest?: { page?: number; query?: string }) => {
      const pane = paneArg ?? stateRef.current.pane;
      if (!isPaneEnabled(pane, backend.capabilities)) return;
      const current = stateRef.current;
      const softwareIntent =
        pane === "software"
          ? {
              page: softwareRequest?.page ?? current.softwarePage.page,
              pageSize: current.softwarePage.pageSize,
              query: softwareRequest?.query ?? current.softwareQuery,
            }
          : undefined;
      const inFlight = softwareInFlightRef.current;
      if (
        softwareIntent &&
        inFlight &&
        inFlight.page === softwareIntent.page &&
        inFlight.pageSize === softwareIntent.pageSize &&
        inFlight.query === softwareIntent.query
      ) {
        return;
      }
      const softwareRequestId = pane === "software" ? ++softwareRequestRef.current : undefined;
      if (softwareIntent && softwareRequestId !== undefined) {
        softwareInFlightRef.current = { id: softwareRequestId, ...softwareIntent };
      }
      dispatch({ type: "loading" });
      try {
        if (pane === "jobs") {
          const jobs = await backend.listJobs();
          if (stateRef.current.pane === "jobs") dispatch({ type: "jobsLoaded", jobs });
        } else if (pane === "workflows") {
          const workflows = await backend.listWorkflows();
          if (stateRef.current.pane === "workflows")
            dispatch({ type: "workflowsLoaded", workflows });
        } else if (pane === "agents" || pane === "metrics") {
          // The metrics pane is a resource-bar view of the same agent data.
          const agents = await backend.listAgents();
          for (const a of agents) {
            pushHistory(cpuHistoryRef.current, a.id, a.cpuPercent, HISTORY_LEN);
            const memPct =
              a.memoryUsedMb !== undefined && a.memoryTotalMb
                ? (a.memoryUsedMb / a.memoryTotalMb) * 100
                : undefined;
            pushHistory(memHistoryRef.current, a.id, memPct, HISTORY_LEN);
            pushHistory(queueHistoryRef.current, a.id, a.queueDepth, HISTORY_LEN);
          }
          if (stateRef.current.pane === pane) dispatch({ type: "agentsLoaded", agents });
        } else {
          if (!softwareIntent) return;
          const { page: pageNumber, pageSize, query } = softwareIntent;
          const page = backend.listSoftwarePage
            ? await backend.listSoftwarePage({
                page: pageNumber,
                pageSize,
                ...(query ? { query } : {}),
              })
            : await backend.listSoftware().then((items) => ({
                items,
                page: 1,
                pageSize: Math.max(1, items.length),
                totalCount: items.length,
                totalPages: 1,
              }));
          if (
            stateRef.current.pane === "software" &&
            softwareRequestId === softwareRequestRef.current
          ) {
            dispatch({
              type: "softwareLoaded",
              page,
              serverFiltered: Boolean(backend.listSoftwarePage),
            });
          }
        }
        if (pane !== "software" || softwareRequestId === softwareRequestRef.current) {
          lastUpdatedRef.current = Date.now();
        }
      } catch (err) {
        if (pane === "software" && softwareRequestId !== softwareRequestRef.current) return;
        if (stateRef.current.pane === pane)
          dispatch({ type: "loadError", error: errorMessage(err) });
      } finally {
        if (softwareInFlightRef.current?.id === softwareRequestId) {
          softwareInFlightRef.current = null;
        }
      }
    },
    [backend],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  const openDetail = useCallback(async () => {
    const s = stateRef.current;
    if (activeLength(s) === 0) return;
    // Metrics is a dashboard with no per-item detail — don't flip into a
    // detail view that renders identically (only the footer would change).
    if (s.pane === "metrics") return;
    dispatch({ type: "openDetail" });
    if (s.pane === "workflows") {
      const run = visibleWorkflows(s)[s.selectedIndex];
      if (!run) return;
      dispatch({ type: "wfDetailLoading" });
      try {
        dispatch({ type: "wfDetailLoaded", detail: await backend.getWorkflowDetail(run.id) });
      } catch (err) {
        dispatch({ type: "wfDetailError", error: errorMessage(err) });
      }
    } else if (s.pane === "jobs") {
      const job = visibleJobs(s)[s.selectedIndex];
      if (!job) return;
      dispatch({ type: "jobDetailLoading" });
      try {
        dispatch({ type: "jobDetailLoaded", detail: await backend.getJobDetail(job.id) });
      } catch (err) {
        dispatch({ type: "jobDetailError", error: errorMessage(err) });
      }
    }
  }, [backend]);

  const openDetailRef = useRef(openDetail);
  openDetailRef.current = openDetail;

  const refetchWorkflowDetail = useCallback(
    async (id: string) => {
      try {
        dispatch({ type: "wfDetailLoaded", detail: await backend.getWorkflowDetail(id) });
      } catch (err) {
        dispatch({ type: "wfDetailError", error: errorMessage(err) });
      }
    },
    [backend],
  );
  const refetchWorkflowDetailRef = useRef(refetchWorkflowDetail);
  refetchWorkflowDetailRef.current = refetchWorkflowDetail;

  // Live workflow steps: subscribe to the Server WS while a workflow detail is
  // open; each step push re-fetches the tree. Unsubscribed on close/unmount.
  const detailRunId =
    state.view === "detail" && state.pane === "workflows" ? state.detailId : undefined;
  useEffect(() => {
    if (!detailRunId) return;
    return backend.subscribeWorkflowStatus(detailRunId, () => {
      void refetchWorkflowDetailRef.current(detailRunId);
    });
  }, [detailRunId, backend]);

  const LOG_TAIL_LINES = 200;
  // `silent` suppresses the loading flash for background follow re-tails.
  const fetchLogs = useCallback(
    async (opts: { open?: boolean; silent?: boolean } = {}) => {
      const s = stateRef.current;
      if (s.pane !== "jobs" || !backend.capabilities.logs) return;
      // On open, target the selection; while following, stay pinned to detailId.
      const target = opts.open
        ? visibleJobs(s)[s.selectedIndex]
        : pinnedItem(visibleJobs(s), s.detailId, s.selectedIndex);
      if (!target) return;
      if (opts.open) dispatch({ type: "openLogs" });
      if (!opts.silent) dispatch({ type: "logsLoading" });
      try {
        const text = await backend.getJobLogs(target.id, LOG_TAIL_LINES);
        dispatch({ type: "logsLoaded", text });
      } catch (err) {
        dispatch({ type: "logsError", error: errorMessage(err) });
      }
    },
    [backend],
  );

  const fetchLogsRef = useRef(fetchLogs);
  fetchLogsRef.current = fetchLogs;

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (active) await loadRef.current();
    };
    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  // Live job status: subscribe to the Server WS while a job detail is open; the
  // subscription is closed on detail-close/unmount. Local backend no-ops.
  // Pinned to detailId so a list reorder mid-view can't retarget the socket.
  const detailJobId = state.view === "detail" && state.pane === "jobs" ? state.detailId : undefined;
  useEffect(() => {
    if (!detailJobId) return;
    return backend.subscribeJobStatus(detailJobId, (status) =>
      dispatch({ type: "jobStatusLive", status }),
    );
  }, [detailJobId, backend]);

  // Local mode has no WS push, so an open job detail would go stale. Re-fetch
  // it on the poll cadence as a backstop. (Remote relies on the WS above, which
  // also keeps the ●live badge — so we don't poll-refetch there.)
  useEffect(() => {
    if (!detailJobId || backend.info.mode !== "local") return;
    const timer = setInterval(() => {
      backend.getJobDetail(detailJobId).then(
        (detail) => dispatch({ type: "jobDetailLoaded", detail }),
        () => {}, // transient errors keep the last good detail on screen
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [detailJobId, backend, pollMs]);

  // Auto-dismiss the transient footer notice a few seconds after it appears.
  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => dispatch({ type: "clearNotice" }), 4000);
    return () => clearTimeout(timer);
  }, [state.notice]);

  // Follow mode: re-tail the open log on a fast interval while enabled.
  const following = state.view === "logs" && state.logs.following;
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void fetchLogsRef.current({ silent: true }), 1500);
    return () => clearInterval(timer);
  }, [following]);

  const cancelConfirmed = useCallback(async () => {
    const { jobId, bulkCount } = stateRef.current.confirm;
    const marked = [...stateRef.current.marked];
    dispatch({ type: "confirmClose" });
    // Bulk cancel: every marked job. One bad id doesn't hide the rest (cancelEach
    // tallies), then clear the marks and refresh.
    if (bulkCount !== undefined) {
      const { ok, failed } = await cancelEach((id) => backend.cancelJob(id), marked);
      dispatch({ type: "clearMarks" });
      dispatch({ type: "notice", message: bulkCancelNotice(ok, failed) });
      await loadRef.current("jobs");
      return;
    }
    if (!jobId) return;
    try {
      await backend.cancelJob(jobId);
      dispatch({ type: "notice", message: `Cancelled ${jobId}` });
      await loadRef.current("jobs");
    } catch (err) {
      dispatch({ type: "notice", message: `Cancel failed: ${errorMessage(err)}` });
    }
  }, [backend]);
  const cancelConfirmedRef = useRef(cancelConfirmed);
  cancelConfirmedRef.current = cancelConfirmed;

  const submitForm = useCallback(async () => {
    const s = stateRef.current;
    const path = s.form.path.trim();
    const isWorkflow = s.pane === "workflows";
    if (!path) {
      dispatch({ type: "formClose" });
      return;
    }
    dispatch({ type: "formSubmitting" });
    try {
      const raw = readFileSync(path, "utf-8");
      const res = isWorkflow
        ? await backend.submitWorkflow(raw)
        : await backend.submitFromSpec(raw);
      dispatch({ type: "formClose" });
      const kind = isWorkflow ? "workflow" : "job";
      dispatch({ type: "notice", message: `Submitted ${kind} ${res.name ?? res.id} → ${res.id}` });
      await loadRef.current(isWorkflow ? "workflows" : "jobs");
    } catch (err) {
      dispatch({ type: "formClose" });
      dispatch({ type: "notice", message: `Submit failed: ${errorMessage(err)}` });
    }
  }, [backend]);

  useInput((input, key) => {
    // Help overlay: any of ? / esc / q closes it; it sits above everything.
    if (stateRef.current.helpOpen) {
      if (input === "?" || key.escape || input === "q") dispatch({ type: "helpClose" });
      return;
    }
    // Confirm overlay captures keys until y (confirm) or n/esc (dismiss).
    if (stateRef.current.confirm.open) {
      if (input === "y" || input === "Y") {
        void cancelConfirmedRef.current();
      } else if (input === "n" || input === "N" || key.escape || key.return) {
        dispatch({ type: "confirmClose" });
      }
      return;
    }
    // Submit-form overlay captures all keystrokes until enter/esc.
    if (stateRef.current.form.open) {
      if (stateRef.current.form.submitting) return;
      if (key.escape) {
        dispatch({ type: "formClose" });
        return;
      }
      if (key.return) {
        void submitForm();
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "formBackspace" });
        return;
      }
      if (input && !key.ctrl && !key.meta) dispatch({ type: "formInput", text: input });
      return;
    }
    // Filter input mode: keystrokes build the filter string until enter/esc.
    if (stateRef.current.filtering) {
      if (key.escape) {
        dispatch({ type: "filterClear" });
        if (stateRef.current.pane === "software") {
          void loadRef.current("software", { page: 1, query: "" });
        }
        return;
      }
      if (key.return) {
        const query = stateRef.current.filter;
        dispatch({ type: "filterCommit" });
        if (stateRef.current.pane === "software") {
          void loadRef.current("software", { page: 1, query });
        }
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "filterBackspace" });
        return;
      }
      if (input && !key.ctrl && !key.meta) dispatch({ type: "filterInput", text: input });
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (input === "?") {
      dispatch({ type: "helpToggle" });
      return;
    }
    if (input === "/") {
      dispatch({ type: "filterOpen" });
      return;
    }
    // In the logs view, navigation keys scroll the fetched buffer (offset up
    // from the tail) instead of moving a list selection. Other keys (f/r/esc/q)
    // fall through to their handlers below.
    if (stateRef.current.view === "logs") {
      const all = stateRef.current.logs.text.replace(/\n$/, "").split("\n");
      const lineCount = grepLines(all, stateRef.current.logs.search).length;
      const max = Math.max(0, lineCount - viewportRows);
      const by = (delta: number) => dispatch({ type: "logsScrollBy", delta, max });
      if (input === "k" || key.upArrow) return by(1);
      if (input === "j" || key.downArrow) return by(-1);
      if (key.pageUp || (key.ctrl && input === "u")) return by(viewportRows);
      if (key.pageDown || (key.ctrl && input === "d")) return by(-viewportRows);
      if (input === "g") return by(max);
      if (input === "G") return by(-max);
    }
    const canSubmitHere =
      (stateRef.current.pane === "jobs" && backend.capabilities.submit) ||
      (stateRef.current.pane === "workflows" && backend.capabilities.workflows);
    if (input === "s" && canSubmitHere) {
      dispatch({ type: "formOpen" });
      return;
    }
    if (key.tab) {
      const next = nextEnabledPane(stateRef.current.pane, backend.capabilities);
      dispatch({ type: "setPane", pane: next });
      void loadRef.current(next, next === "software" ? { page: 1, query: "" } : undefined);
      return;
    }
    // Number keys jump straight to a pane (1=Jobs … 5=Software); ignored when
    // that pane is disabled in this mode.
    if (input >= "1" && input <= "5") {
      const target = paneAtPosition(Number(input), backend.capabilities);
      if (target) {
        dispatch({ type: "setPane", pane: target });
        void loadRef.current(target, target === "software" ? { page: 1, query: "" } : undefined);
      }
      return;
    }
    // List navigation only moves the cursor in the list view — never under an
    // open detail (logs-view nav is handled + returned above).
    if (stateRef.current.view === "list") {
      if (stateRef.current.pane === "software" && backend.listSoftwarePage) {
        const { page, totalPages } = stateRef.current.softwarePage;
        if (input === "[" && page > 1) {
          dispatch({ type: "selectFirst" });
          void loadRef.current("software", { page: page - 1 });
          return;
        }
        if (input === "]" && page < totalPages) {
          dispatch({ type: "selectFirst" });
          void loadRef.current("software", { page: page + 1 });
          return;
        }
      }
      if (input === "j" || key.downArrow) dispatch({ type: "selectNext" });
      if (input === "k" || key.upArrow) dispatch({ type: "selectPrev" });
      if (input === "g") dispatch({ type: "selectFirst" });
      if (input === "G") dispatch({ type: "selectLast" });
      if (key.pageDown || (key.ctrl && input === "d"))
        dispatch({ type: "pageDown", size: viewportRows });
      if (key.pageUp || (key.ctrl && input === "u"))
        dispatch({ type: "pageUp", size: viewportRows });
    }
    if (key.return) void openDetailRef.current();
    if (input === "l" && backend.capabilities.logs) void fetchLogsRef.current({ open: true });
    if (input === "f" && stateRef.current.view === "logs") dispatch({ type: "toggleLogsFollow" });
    if (
      input === "c" &&
      !key.ctrl &&
      !key.meta &&
      backend.capabilities.ssh &&
      stateRef.current.pane === "agents"
    ) {
      const agent = visibleAgents(stateRef.current)[stateRef.current.selectedIndex];
      if (agent && onSsh) onSsh(agent.id);
    }
    if (key.escape) {
      // esc backs out of detail/logs, else clears an active filter.
      if (stateRef.current.view !== "list") dispatch({ type: "closeDetail" });
      else if (stateRef.current.filter) {
        dispatch({ type: "filterClear" });
        if (stateRef.current.pane === "software") {
          void loadRef.current("software", { page: 1, query: "" });
        }
      }
    }
    if (input === "o") dispatch({ type: "cycleSort" });
    if (input === "r") {
      // In the logs view 'r' re-tails the selected job; elsewhere reloads the list.
      if (stateRef.current.view === "logs") void fetchLogsRef.current();
      else void loadRef.current();
    }
    // Space toggles a multi-select mark on the highlighted job (list view only).
    if (input === " " && stateRef.current.pane === "jobs" && stateRef.current.view === "list") {
      dispatch({ type: "toggleMark" });
    }
    if (input === "x" && stateRef.current.pane === "jobs") {
      // In the list view, with jobs marked, x cancels the whole marked set.
      // In the detail/logs view (or with nothing marked) it cancels the single
      // job in focus — bulk-cancelling the marked set while viewing one job
      // would be surprising.
      if (stateRef.current.marked.size > 0 && stateRef.current.view === "list") {
        dispatch({ type: "confirmBulkCancelOpen", count: stateRef.current.marked.size });
      } else {
        const target = pinnedItem(
          visibleJobs(stateRef.current),
          stateRef.current.detailId,
          stateRef.current.selectedIndex,
        );
        if (target) {
          dispatch({ type: "confirmCancelOpen", jobId: target.id, jobName: target.name });
        }
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header backend={backend} pane={state.pane} />
      <FilterBar
        filter={state.view === "logs" ? state.logs.search : state.filter}
        filtering={state.filtering}
      />
      <Box marginY={1} flexDirection="column">
        {state.helpOpen ? (
          <HelpOverlay
            mode={backend.info.mode}
            canLogs={backend.capabilities.logs}
            canSsh={backend.capabilities.ssh}
            canWorkflows={backend.capabilities.workflows}
          />
        ) : state.pane === "jobs" && state.view === "logs" ? (
          <LogsPane
            state={state}
            job={pinnedItem(visibleJobs(state), state.detailId, state.selectedIndex)}
            viewportRows={viewportRows}
          />
        ) : state.pane === "jobs" ? (
          <JobsPane state={state} mode={backend.info.mode} viewportRows={viewportRows} />
        ) : state.pane === "workflows" ? (
          <WorkflowsPane state={state} viewportRows={viewportRows} />
        ) : state.pane === "agents" ? (
          <AgentsPane state={state} viewportRows={viewportRows} />
        ) : state.pane === "metrics" ? (
          <MetricsPane
            state={state}
            viewportRows={viewportRows}
            cpuHistory={cpuHistoryRef.current}
            memHistory={memHistoryRef.current}
            queueHistory={queueHistoryRef.current}
          />
        ) : (
          <SoftwarePane state={state} viewportRows={viewportRows} />
        )}
      </Box>
      {state.confirm.open ? (
        <ConfirmPrompt
          jobId={state.confirm.jobId}
          jobName={state.confirm.jobName}
          bulkCount={state.confirm.bulkCount}
        />
      ) : null}
      {state.form.open ? (
        <SubmitForm
          path={state.form.path}
          submitting={state.form.submitting}
          kind={state.pane === "workflows" ? "workflow" : "job"}
        />
      ) : null}
      <Footer
        notice={state.notice}
        view={state.view}
        pane={state.pane}
        canSubmit={backend.capabilities.submit}
        canWorkflows={backend.capabilities.workflows}
        canLogs={backend.capabilities.logs}
        canSsh={backend.capabilities.ssh}
        sortKey={state.sortKey}
        lastUpdatedAt={lastUpdatedRef.current}
        now={Date.now()}
      />
    </Box>
  );
}
