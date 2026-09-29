const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { previewScope, diagnosticCode } = require("./resources.cjs");

const INSTANCE = "app.kubernetes.io/instance";
const COMPONENT = "app.kubernetes.io/component";
const RESOURCES = "pods,jobs,persistentvolumeclaims,deployments,statefulsets";
const KINDS = new Map([
  ["Pod", "POD"], ["Job", "JOB"], ["PersistentVolumeClaim", "PVC"],
  ["Deployment", "DEPLOYMENT"], ["StatefulSet", "STATEFULSET"],
]);
const COMPONENTS = new Map([
  ["server", "SERVER"], ["registry", "REGISTRY"], ["web", "WEB"],
  ["scheduler", "SCHEDULER"], ["gateway", "GATEWAY"], ["postgres", "POSTGRES"],
  ["redis", "REDIS"], ["rustfs", "RUSTFS"], ["seed", "SEED"],
  ["db-migration", "DB_MIGRATION"], ["rustfs-bootstrap", "RUSTFS_BOOTSTRAP"],
]);
const PHASES = new Map([
  ["Pending", "PENDING"], ["Running", "RUNNING"], ["Succeeded", "SUCCEEDED"],
  ["Failed", "FAILED"], ["Unknown", "UNKNOWN"], ["Bound", "BOUND"], ["Lost", "LOST"],
]);
const REASONS = new Map([
  ["ContainerCreating", "CONTAINER_CREATING"], ["PodInitializing", "POD_INITIALIZING"],
  ["ImagePullBackOff", "IMAGE_PULL_BACKOFF"], ["ErrImagePull", "ERR_IMAGE_PULL"],
  ["InvalidImageName", "INVALID_IMAGE_NAME"], ["CrashLoopBackOff", "CRASH_LOOP_BACKOFF"],
  ["CreateContainerConfigError", "CONTAINER_CONFIG_ERROR"], ["CreateContainerError", "CONTAINER_CREATE_ERROR"],
  ["RunContainerError", "CONTAINER_RUN_ERROR"], ["OOMKilled", "OOM_KILLED"],
  ["Error", "ERROR"], ["Completed", "COMPLETED"], ["Unschedulable", "UNSCHEDULABLE"],
  ["Evicted", "EVICTED"], ["DeadlineExceeded", "DEADLINE_EXCEEDED"],
  ["BackoffLimitExceeded", "BACKOFF_LIMIT_EXCEEDED"], ["FailedCreate", "FAILED_CREATE"],
  ["ProgressDeadlineExceeded", "PROGRESS_DEADLINE_EXCEEDED"],
  ["MinimumReplicasUnavailable", "MINIMUM_REPLICAS_UNAVAILABLE"],
  ["ContainersNotReady", "CONTAINERS_NOT_READY"], ["PodCompleted", "POD_COMPLETED"],
]);
const array = (value) => Array.isArray(value) ? value : [];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 999) : 0;
const reason = (value) => value === undefined || value === "" ? "NONE" : REASONS.get(value) ?? "UNKNOWN";

function podState(item) {
  const current = item.status ?? {};
  const containers = array(current.containerStatuses);
  const statuses = [...array(current.initContainerStatuses), ...containers];
  const stalled = statuses.find((entry) => entry?.state?.waiting ||
    (entry?.state?.terminated && entry.state.terminated.exitCode !== 0));
  const condition = array(current.conditions).find((entry) => entry?.type === "PodScheduled" && entry.status === "False");
  return {
    status: item.metadata.deletionTimestamp ? "TERMINATING" : PHASES.get(current.phase) ?? "UNKNOWN",
    reason: reason(stalled?.state?.waiting?.reason ?? stalled?.state?.terminated?.reason ??
      condition?.reason ?? current.reason),
    ready: count(containers.filter((entry) => entry?.ready === true).length),
    desired: count(array(item.spec?.containers).length),
    restarts: count(statuses.reduce((sum, entry) => sum + count(entry?.restartCount), 0)),
    failed: 0,
  };
}

function workloadState(item) {
  if (item.kind === "Pod") return podState(item);
  const current = item.status ?? {};
  const conditions = array(current.conditions);
  const result = { reason: "NONE", ready: 0, desired: 0, restarts: 0, failed: 0 };
  if (item.kind === "PersistentVolumeClaim") {
    return { ...result, status: PHASES.get(current.phase) ?? "UNKNOWN" };
  }
  if (item.kind === "Job") {
    const failure = conditions.find((entry) =>
      ["Failed", "FailureTarget"].includes(entry?.type) && entry.status === "True");
    const complete = conditions.some((entry) => entry?.type === "Complete" && entry.status === "True");
    return {
      ...result, status: failure ? "FAILED" : complete ? "COMPLETE" : count(current.active) ? "ACTIVE" : "PENDING",
      reason: reason(failure?.reason), ready: count(current.succeeded),
      desired: count(item.spec?.completions ?? 1), failed: count(current.failed),
    };
  }
  const failure = conditions.find((entry) =>
    (entry?.type === "ReplicaFailure" && entry.status === "True") ||
    (entry?.type === "Progressing" && entry.status === "False"));
  const desired = count(item.spec?.replicas ?? 1);
  const ready = count(current.readyReplicas);
  const observed = Number.isSafeInteger(current.observedGeneration) &&
    Number.isSafeInteger(item.metadata.generation) && current.observedGeneration >= item.metadata.generation;
  return {
    ...result, ready, desired, reason: reason(failure?.reason),
    status: failure ? "FAILED" : !observed ? "RECONCILING" :
      ready >= desired && count(current.updatedReplicas) >= desired ? "READY" : "NOT_READY",
  };
}

function workloadLines(value, scope) {
  if (!value || !Array.isArray(value.items)) throw new SyntaxError("Invalid workload inventory");
  const groups = new Map();
  for (const item of value.items) {
    if (!KINDS.has(item?.kind) || item.metadata?.namespace !== "preview" ||
        scope.namespace !== "preview" || item.metadata?.labels?.[INSTANCE] !== scope.release) continue;
    const labels = item.metadata.labels;
    const template = item.spec?.template?.metadata?.labels;
    const component = COMPONENTS.get(labels[COMPONENT] ?? labels.component ??
      template?.[COMPONENT] ?? template?.component) ?? "UNKNOWN";
    const state = workloadState(item);
    const key = `kind=${KINDS.get(item.kind)} component=${component} status=${state.status} reason=${state.reason}`;
    const group = groups.get(key) ?? { count: 0, ready: 0, desired: 0, restarts: 0, failed: 0 };
    for (const field of Object.keys(group)) group[field] = count(group[field] + (field === "count" ? 1 : state[field]));
    groups.set(key, group);
  }
  if (!groups.size) return ["KQ_PREVIEW_WORKLOAD kind=UNKNOWN component=UNKNOWN status=EMPTY reason=NONE count=0"];
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) =>
    `KQ_PREVIEW_WORKLOAD ${key} count=${group.count} ready=${group.ready} desired=${group.desired} restarts=${group.restarts} failed=${group.failed}`);
}

function collectWorkloads(scope, signal, execute = execFile) {
  return new Promise((resolve, reject) => {
    execute("kubectl", [
      "get", RESOURCES, "-n", "preview", "-l", `${INSTANCE}=${scope.release}`,
      "-o", "json", "--request-timeout=8s",
    ], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, signal },
    (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        if (error.killed && !signal.aborted) error.code = "ETIMEDOUT";
        reject(error);
      } else {
        try { resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); }
      }
    });
  });
}

function waitInterval(milliseconds, signal, timers = { setTimeout, clearTimeout }) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = timers.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function watch(env, {
  collect = collectWorkloads, emit = console.log, signals = process, sleep = waitInterval,
} = {}) {
  const scope = previewScope(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signals.once("SIGTERM", stop);
  signals.once("SIGINT", stop);
  let previous;
  try {
    while (!controller.signal.aborted) {
      let lines;
      try { lines = workloadLines(await collect(scope, controller.signal), scope); }
      catch (error) { lines = [`KQ_PREVIEW_WORKLOAD_ERROR code=${diagnosticCode(error)}`]; }
      if (controller.signal.aborted) break;
      const snapshot = lines.join("\n");
      if (snapshot !== previous) {
        for (const line of lines) emit(line);
        previous = snapshot;
      }
      await sleep(15000, controller.signal);
    }
  } finally {
    controller.abort();
    signals.removeListener("SIGTERM", stop);
    signals.removeListener("SIGINT", stop);
  }
}

function helmErrorCode(text) {
  if (typeof text !== "string") return "UNKNOWN";
  const content = text.slice(-1024 * 1024);
  const code = diagnosticCode({ stderr: content });
  if (code !== "UNCLASSIFIED_FAILURE") return code;
  if (/timed out|context deadline exceeded|deadline exceeded/i.test(content)) return "HELM_TIMEOUT";
  if (/another operation .*in progress|operation cannot be fulfilled|object has been modified|already exists|conflict|invalid ownership metadata|cannot be imported into the current release/i.test(content)) return "HELM_CONFLICT";
  if (/error validating|validation failed|failed to validate|parse error|template:|execution error at|values don.t meet|invalid:|required value/i.test(content)) return "HELM_VALIDATION_FAILED";
  return "UNKNOWN";
}

async function runCLI(args, env = process.env, options = {}) {
  const emit = options.emit ?? console.log;
  const files = options.files ?? fs;
  const [mode, path] = args;
  try {
    if (mode === "watch" && args.length === 1) await watch(env, options);
    else if (mode === "helm-error" && args.length === 2 && path) {
      emit(`KQ_PREVIEW_HELM_ERROR code=${helmErrorCode(files.readFileSync(path === "-" ? 0 : path, "utf8"))}`);
    } else emit("KQ_PREVIEW_WORKLOAD_ERROR code=INVALID_OPERATION");
  } catch (error) {
    emit(`${mode === "helm-error" ? "KQ_PREVIEW_HELM_ERROR" : "KQ_PREVIEW_WORKLOAD_ERROR"} code=${diagnosticCode(error)}`);
  }
}

if (require.main === module) {
  runCLI(process.argv.slice(2)).catch(() => {
    console.error("KQ_PREVIEW_WORKLOAD_ERROR code=UNCLASSIFIED_FAILURE");
  });
}

module.exports = { workloadLines, collectWorkloads, waitInterval, watch, helmErrorCode, runCLI };
