const { describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const { previewScope } = require("./resources.cjs");
const { workloadLines, collectWorkloads, waitInterval, watch, helmErrorCode, runCLI } = require("./workload-status.cjs");

const env = {
  PREVIEW_PR: "17", PREVIEW_NAMESPACE: "preview",
  PREVIEW_RELEASE: "kq-pr-17", GITHUB_REPOSITORY: "example/project",
};
const scope = previewScope(env);
const privateText = "PRIVATE-canary-token-password-url";
const instance = "app.kubernetes.io/instance";
const component = "app.kubernetes.io/component";

function pod(overrides = {}) {
  return {
    kind: "Pod",
    metadata: {
      name: privateText, namespace: "preview", generation: 1,
      labels: { [instance]: "kq-pr-17", [component]: "server", private: privateText },
    },
    spec: { containers: [{ name: privateText, image: privateText, env: [{ value: privateText }] }] },
    status: {
      phase: "Pending", message: privateText,
      containerStatuses: [{
        name: privateText, ready: false, restartCount: 2,
        state: { waiting: { reason: "ImagePullBackOff", message: privateText } },
      }],
    },
    ...overrides,
  };
}

const lines = (items) => workloadLines({ items }, scope);

describe("safe preview workload projection", () => {
  test("emits only allowlisted fields and bounded counts, never names or messages", () => {
    const result = lines([pod(), pod()]);
    expect(result).toEqual([
      "KQ_PREVIEW_WORKLOAD kind=POD component=SERVER status=PENDING reason=IMAGE_PULL_BACKOFF count=2 ready=0 desired=2 restarts=4 failed=0",
    ]);
    expect(result.join("")).not.toContain(privateText);
    const unknown = pod();
    unknown.metadata.labels[component] = `server\n${privateText}`;
    unknown.status.phase = privateText;
    unknown.status.containerStatuses[0].state.waiting.reason = privateText;
    unknown.status.containerStatuses[0].restartCount = Number.MAX_SAFE_INTEGER;
    expect(lines([unknown])[0]).toContain("component=UNKNOWN status=UNKNOWN reason=UNKNOWN");
    expect(lines([unknown])[0]).toContain("restarts=999");
    expect(lines([unknown]).join("")).not.toContain(privateText);
  });

  test("filters both namespace and exact PR instance even if the collector overreturns", () => {
    const otherPR = pod();
    otherPR.metadata.labels[instance] = "kq-pr-170";
    const otherNamespace = pod();
    otherNamespace.metadata.namespace = "default";
    const missingInstance = pod();
    delete missingInstance.metadata.labels[instance];
    const secret = pod({ kind: "Secret", data: { token: privateText } });
    expect(lines([otherPR, otherNamespace, missingInstance, secret, null])).toEqual(lines([]));
    expect(workloadLines({ items: [pod()] }, { ...scope, namespace: "default" })).toEqual(lines([]));
  });

  test("supports legacy web component and controller template labels without echoing arbitrary labels", () => {
    const web = pod();
    web.metadata.labels = { [instance]: scope.release, component: "web" };
    expect(lines([web])[0]).toContain("component=WEB");
    const deployment = pod({
      kind: "Deployment", spec: { replicas: 2, template: { metadata: { labels: { [component]: "gateway" } } } },
      status: { readyReplicas: 2, updatedReplicas: 2, observedGeneration: 1 },
    });
    deployment.metadata.labels = { [instance]: scope.release };
    expect(lines([deployment])[0]).toContain("kind=DEPLOYMENT component=GATEWAY status=READY");
    deployment.status.observedGeneration = 0;
    expect(lines([deployment])[0]).toContain("status=RECONCILING");
  });

  test("projects init-container failures, scheduler conditions, job failures and PVC phases", () => {
    const init = pod();
    init.status.initContainerStatuses = [{
      restartCount: 4, state: { terminated: { exitCode: 1, reason: "OOMKilled", message: privateText } },
    }];
    expect(lines([init])[0]).toContain("reason=OOM_KILLED");
    const pending = pod({ status: { phase: "Pending", conditions: [
      { type: "PodScheduled", status: "False", reason: "Unschedulable", message: privateText },
    ] } });
    expect(lines([pending])[0]).toContain("reason=UNSCHEDULABLE");
    const job = pod({ kind: "Job", status: { failed: 2, conditions: [
      { type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: privateText },
    ] } });
    expect(lines([job])[0]).toContain("status=FAILED reason=BACKOFF_LIMIT_EXCEEDED");
    expect(lines([job])[0]).toContain("failed=2");
    expect(lines([pod({ kind: "PersistentVolumeClaim", status: { phase: "Pending" } })])[0])
      .toContain("kind=PVC component=SERVER status=PENDING");
  });

  test.each([
    ["ErrImagePull", "ERR_IMAGE_PULL"], ["ImagePullBackOff", "IMAGE_PULL_BACKOFF"],
  ])("reports initContainer %s before the main container's PodInitializing state", (input, expected) => {
    const waiting = pod();
    waiting.spec.initContainers = [{ name: privateText, image: privateText }];
    waiting.status.initContainerStatuses = [{
      name: privateText, restartCount: 0,
      state: { waiting: { reason: input, message: privateText } },
    }];
    waiting.status.containerStatuses[0].state.waiting.reason = "PodInitializing";
    expect(lines([waiting])[0]).toContain(`reason=${expected}`);
    expect(lines([waiting]).join("")).not.toContain(privateText);
    waiting.status.initContainerStatuses[0].state = { terminated: { exitCode: 0, reason: "Completed" } };
    expect(lines([waiting])[0]).toContain("reason=POD_INITIALIZING");
  });

  test("normalizes item order and never treats malformed counters as printable data", () => {
    const failed = pod({ status: { phase: "Failed", containerStatuses: [{ restartCount: privateText }] } });
    expect(lines([pod(), failed])).toEqual(lines([failed, pod()]));
    expect(lines([failed])[0]).toContain("restarts=0");
    expect(() => workloadLines({ items: null }, scope)).toThrow();
  });
});

describe("read-only observer lifecycle", () => {
  test("collector uses only the fixed namespaced selector and a ten-second cancellable command", async () => {
    const signal = new AbortController().signal;
    const value = { items: [pod()] };
    const execute = (command, args, options, callback) => {
      expect(command).toBe("kubectl");
      expect(args).toEqual([
        "get", "pods,jobs,persistentvolumeclaims,deployments,statefulsets",
        "-n", "preview", "-l", "app.kubernetes.io/instance=kq-pr-17",
        "-o", "json", "--request-timeout=8s",
      ]);
      expect(options.timeout).toBe(10000);
      expect(options.killSignal).toBe("SIGKILL");
      expect(options.signal).toBe(signal);
      expect(options.maxBuffer).toBe(4 * 1024 * 1024);
      callback(null, JSON.stringify(value));
    };
    expect(await collectWorkloads(scope, signal, execute)).toEqual(value);
  });

  test("collector parse and command timeout errors remain safely classifiable", async () => {
    const signal = new AbortController().signal;
    await expect(collectWorkloads(scope, signal, (_command, _args, _options, callback) =>
      callback(null, privateText))).rejects.toBeInstanceOf(SyntaxError);
    await expect(collectWorkloads(scope, signal, (_command, _args, _options, callback) =>
      callback(Object.assign(new Error(privateText), { killed: true }))))
      .rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  test("prints only changed snapshots, polls every fifteen seconds and removes signal handlers", async () => {
    const signals = new EventEmitter();
    const output = [];
    let calls = 0;
    await watch(env, {
      signals, emit: (line) => output.push(line),
      collect: async () => ({ items: ++calls < 3 ? [pod()] : [] }),
      sleep: async (milliseconds) => {
        expect(milliseconds).toBe(15000);
        if (calls === 3) signals.emit("SIGTERM");
      },
    });
    expect(calls).toBe(3);
    expect(output).toEqual([...lines([pod()]), ...lines([])]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  test.each(["SIGTERM", "SIGINT"])("%s aborts collection immediately without printing raw abort errors", async (event) => {
    const signals = new EventEmitter();
    const output = [];
    let observed;
    await watch(env, {
      signals, emit: (line) => output.push(line),
      collect: (_scope, signal) => new Promise((_resolve, reject) => {
        observed = signal;
        signal.addEventListener("abort", () => reject(new Error(privateText)), { once: true });
        signals.emit(event);
      }),
      sleep: async () => { throw new Error("must not sleep"); },
    });
    expect(observed.aborted).toBe(true);
    expect(output).toEqual([]);
    expect(signals.listenerCount(event)).toBe(0);
  });

  test("stopping the polling wait cancels its timer without a real delay", async () => {
    const controller = new AbortController();
    const cleared = [];
    const waiting = waitInterval(15000, controller.signal, {
      setTimeout: (_callback, milliseconds) => { expect(milliseconds).toBe(15000); return 123; },
      clearTimeout: (timer) => cleared.push(timer),
    });
    controller.abort();
    await waiting;
    expect(cleared).toEqual([123]);
  });

  test("observer failures are fixed, deduplicated and do not prevent a later successful snapshot", async () => {
    const signals = new EventEmitter();
    const output = [];
    let calls = 0;
    await watch(env, {
      signals, emit: (line) => output.push(line),
      collect: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error(privateText), {
          stderr: `forbidden: ${privateText} cannot list resource "pods" in API group ""`,
        });
        return { items: [] };
      },
      sleep: async () => { if (calls === 3) signals.emit("SIGINT"); },
    });
    expect(output).toEqual([
      "KQ_PREVIEW_WORKLOAD_ERROR code=RBAC_DENIED verb=list resource=pods group=core", ...lines([]),
    ]);
    expect(output.join("")).not.toContain(privateText);
  });

  test("execFile stderr reaches classification without exposing raw command output", async () => {
    const signals = new EventEmitter();
    const output = [];
    await watch(env, {
      signals, emit: (line) => output.push(line),
      collect: (currentScope, signal) => collectWorkloads(currentScope, signal,
        (_command, _args, _options, callback) => callback(new Error(privateText), privateText,
          `Forbidden: ${privateText} cannot list resource "pods" in API group ""`)),
      sleep: async () => signals.emit("SIGTERM"),
    });
    expect(output).toEqual([
      "KQ_PREVIEW_WORKLOAD_ERROR code=RBAC_DENIED verb=list resource=pods group=core",
    ]);
    expect(output.join("")).not.toContain(privateText);
  });

  test("invalid scope never reaches the collector and is nonfatal to the caller", async () => {
    const output = [];
    await runCLI(["watch"], { ...env, PREVIEW_NAMESPACE: "default" }, {
      collect: async () => { throw new Error("must not collect"); },
      emit: (line) => output.push(line),
    });
    expect(output).toEqual(["KQ_PREVIEW_WORKLOAD_ERROR code=INVALID_SCOPE"]);
  });
});

describe("private Helm error classification", () => {
  test.each([
    ["timed out waiting for the condition", "HELM_TIMEOUT"],
    ["context deadline exceeded", "HELM_TIMEOUT"],
    ["error validating data", "HELM_VALIDATION_FAILED"],
    ["execution error at (private/chart.yaml:1): required value", "HELM_VALIDATION_FAILED"],
    ["another operation (install/upgrade/rollback) is in progress", "HELM_CONFLICT"],
    ["rendered manifests contain a resource that already exists", "HELM_CONFLICT"],
    ["x509: certificate signed by unknown authority", "API_TLS_FAILURE"],
    [privateText, "UNKNOWN"],
  ])("maps %s to a fixed code", (input, expected) => {
    expect(helmErrorCode(`${input}\n${privateText}`)).toBe(expected);
  });

  test("only emits recognized RBAC verb/resource/group, never an arbitrary resource or principal", () => {
    expect(helmErrorCode(`forbidden: ${privateText} cannot create resource "jobs" in API group "batch"`))
      .toBe("RBAC_DENIED verb=create resource=jobs group=batch");
    expect(helmErrorCode(`forbidden: ${privateText} cannot create resource "${privateText}" in API group "private"`))
      .toBe("RBAC_DENIED");
  });

  test.each(["/private/helm.log", "-"])("classifies %s entirely in memory and prints no path or contents", async (path) => {
    const output = [];
    await runCLI(["helm-error", path], {}, {
      emit: (line) => output.push(line),
      files: { readFileSync: (source, encoding) => {
        expect(source).toBe(path === "-" ? 0 : path);
        expect(encoding).toBe("utf8");
        return `UPGRADE FAILED: ${privateText}: context deadline exceeded`;
      } },
    });
    expect(output).toEqual(["KQ_PREVIEW_HELM_ERROR code=HELM_TIMEOUT"]);
  });

  test.each(["ENOENT", "EACCES", "EIO"])("file/stdin read error %s cannot expose its private message", async (code) => {
    const output = [];
    await runCLI(["helm-error", "-"], {}, {
      emit: (line) => output.push(line),
      files: { readFileSync: () => { throw Object.assign(new Error(privateText), { code }); } },
    });
    expect(output).toEqual([`KQ_PREVIEW_HELM_ERROR code=${code === "ENOENT" ? "COMMAND_OR_FILE_MISSING" : "UNCLASSIFIED_FAILURE"}`]);
  });
});
