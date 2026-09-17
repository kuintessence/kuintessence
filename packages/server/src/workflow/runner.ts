import {
  createLogger,
  createUsecaseExecutor,
  extractRunGraph,
  type RunResult,
  type RunWorkflowOptions,
  runWorkflow,
  type UsecaseExecutorDeps,
  type WorkflowRunGraph,
} from "@kuintessence/shared";
import { parseWorkflowYaml } from "./parser";

const logger = createLogger("workflow-runner");

export interface WorkflowRunnerDeps extends UsecaseExecutorDeps {
  resolveWorkflowVersion?: RunWorkflowOptions["resolveWorkflowVersion"];
  /** Persist a finished run (audit/listing) and return its id. Receives the
   *  full per-node result plus the run's node/edge graph so the record can
   *  store both. When omitted, the run executes without being recorded and the
   *  result carries no runId. */
  persistRun?: (name: string, result: RunResult, graph: WorkflowRunGraph) => Promise<string>;
}

/**
 * Top-level workflow runner: parse + statically validate the YAML, then
 * orchestrate it via the engine with a usecase executor built from the given
 * transport deps (resolvePackage / submitJob). This is the single entry point
 * the Server route wires real services into. When `persistRun` is wired the run is
 * recorded and its `runId` is returned alongside the per-node result.
 */
export function createWorkflowRunner(
  deps: WorkflowRunnerDeps,
): (yaml: string) => Promise<RunResult & { runId?: string }> {
  const executor = createUsecaseExecutor(deps);
  return async (yaml) => {
    const wf = parseWorkflowYaml(yaml);
    const result = await runWorkflow(wf, executor, {
      resolveWorkflowVersion: deps.resolveWorkflowVersion,
    });
    if (deps.persistRun) {
      // Best-effort audit: the run already executed, so a persistence failure
      // must not fail the response — surface the result, just without a runId.
      try {
        const runId = await deps.persistRun(wf.name, result, extractRunGraph(wf));
        return { ...result, runId };
      } catch (err) {
        logger.error(
          { err, name: wf.name },
          "Failed to persist workflow run; returning result anyway",
        );
      }
    }
    return result;
  };
}
