const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  previewScope, ownerMetadata, prepare, applyCredentials, cleanup, runCLI,
} = require("./resources.cjs");

const INSTANCE = "app.kubernetes.io/instance";
const MANAGER = "app.kubernetes.io/managed-by";
const PR = "kuintessence.com/preview-pr";
const REPOSITORY = "kuintessence.com/repository";

function environment(pr = "15") {
  return {
    PREVIEW_PR: pr, PREVIEW_RELEASE: `kq-pr-${pr}`,
    PREVIEW_NAMESPACE: "preview", GITHUB_REPOSITORY: "example/project",
  };
}

function object(scope, kind, name, managedByHelm = false) {
  const metadata = {
    ...ownerMetadata(scope, name), uid: `${kind}-${name}`, resourceVersion: "1",
  };
  if (managedByHelm) {
    metadata.labels[MANAGER] = "Helm";
    metadata.annotations["meta.helm.sh/release-name"] = scope.release;
    metadata.annotations["meta.helm.sh/release-namespace"] = scope.namespace;
  }
  return { apiVersion: "v1", kind, metadata };
}

function fixtures(scope) {
  const marker = object(scope, "ConfigMap", scope.marker);
  const secret = {
    ...object(scope, "Secret", scope.secret), type: "Opaque",
    data: { POSTGRES_PASSWORD: Buffer.from("fixture-only").toString("base64") },
  };
  const claim = object(scope, "PersistentVolumeClaim", `data-${scope.release}-postgres-0`);
  const workload = object(scope, "StatefulSet", `${scope.release}-postgres`, true);
  const storage = {
    apiVersion: "v1", kind: "Secret", type: "helm.sh/release.v1",
    metadata: {
      name: `sh.helm.release.v1.${scope.release}.v1`, namespace: scope.namespace,
      labels: { owner: "helm", name: scope.release, status: "deployed" },
    },
  };
  const release = { name: scope.release, namespace: scope.namespace, status: "deployed" };
  return { marker, secret, claim, workload, storage, release };
}

function mockCluster(items = [], releases = [], options = {}) {
  const state = { items: structuredClone(items), releases: structuredClone(releases), calls: [] };
  state.run = (command, args, input) => {
    const call = { command, args, input };
    state.calls.push(call);
    options.before?.(call, state);
    expect(args[args.indexOf("-n") + 1]).toBe("preview");
    expect(args).toContain("-n");
    expect(args).not.toContain("--all-namespaces");
    expect(args).not.toContain("--create-namespace");
    expect(args.some((arg) => /^(nodes?|namespaces?)$/.test(arg))).toBe(false);
    if (args.includes("--raw")) {
      expect(command).toBe("kubectl");
      expect(args[2]).toBe("delete");
      expect(args[args.indexOf("--raw") + 1])
        .toMatch(/^\/api\/v1\/namespaces\/preview\/(persistentvolumeclaims|secrets|configmaps)\/[a-z0-9-]+$/);
    }
    if (command === "helm") {
      if (args[0] === "list") {
        expect(args).toContain("--all");
        const filter = args[args.indexOf("--filter") + 1];
        return JSON.stringify(state.releases.filter((entry) => `^${entry.name}$` === filter));
      }
      expect(args[0]).toBe("uninstall");
      expect(args).toContain("--wait");
      expect(args.slice(-2)).toEqual(["--cascade", "foreground"]);
      if (options.uninstallError) throw new Error("mock Helm failure");
      const release = args[1];
      state.releases = state.releases.filter((entry) => entry.name !== release);
      state.items = state.items.filter((entry) => {
        if (entry.metadata.name === options.keepAfterUninstall) return true;
        if (entry.type === "helm.sh/release.v1") return entry.metadata.labels.name !== release;
        if (entry.metadata.labels?.[INSTANCE] !== release) return true;
        return entry.kind === "PersistentVolumeClaim" ||
          entry.metadata.name === `${release}-secrets` ||
          entry.metadata.name === `${release}-preview-owner`;
      });
      return "";
    }
    expect(command).toBe("kubectl");
    const [verb, kind, name] = args.slice(2);
    if (verb === "get" && kind.includes(",")) {
      if (options.inventoryError) throw new Error("mock RBAC denied");
      return JSON.stringify({ kind: "List", items: state.items });
    }
    if (verb === "get") {
      const found = state.items.find((entry) => entry.kind === kind && entry.metadata.name === name);
      return found ? JSON.stringify(found) : "";
    }
    if (verb === "create" || verb === "apply") {
      const next = JSON.parse(input);
      expect(next.metadata.namespace).toBe("preview");
      const index = state.items.findIndex((entry) =>
        entry.kind === next.kind && entry.metadata.name === next.metadata.name);
      if (verb === "create" && index !== -1) throw new Error("mock AlreadyExists");
      next.metadata.uid ??= `${next.kind}-${next.metadata.name}`;
      next.metadata.resourceVersion ??= "1";
      if (index === -1) state.items.push(next);
      else state.items[index] = next;
      return "";
    }
    expect(verb).toBe("delete");
    expect(kind).toBe("--raw");
    expect(args).toContain("-f");
    expect(args).toContain("--request-timeout=30s");
    const [, , , , , plural, target] = name.split("/");
    const resourceKind = { persistentvolumeclaims: "PersistentVolumeClaim", secrets: "Secret", configmaps: "ConfigMap" }[plural];
    const resource = state.items.find((entry) => entry.kind === resourceKind && entry.metadata.name === target);
    const body = JSON.parse(input);
    expect(body.apiVersion).toBe("v1");
    expect(body.kind).toBe("DeleteOptions");
    expect(body.propagationPolicy).toBe("Foreground");
    if (!resource) throw new Error("404 NotFound");
    if (body.preconditions.uid !== resource.metadata.uid ||
        body.preconditions.resourceVersion !== resource.metadata.resourceVersion) {
      throw new Error("409 Conflict: deletion preconditions failed");
    }
    if (options.deleteFailure === target) throw new Error("mock delete failure");
    if (options.keepTerminating === target) resource.metadata.deletionTimestamp = "2026-09-29T00:00:00Z";
    else state.items = state.items.filter((entry) => entry !== resource);
    return "";
  };
  return state;
}

function mutations(state) {
  return state.calls.filter(({ command, args }) =>
    command === "helm" ? args[0] === "uninstall" : ["create", "apply", "delete"].includes(args[2]));
}

describe("fixed preview namespace lifecycle", () => {
  test.each([
    { PREVIEW_NAMESPACE: "default" }, { PREVIEW_NAMESPACE: "kq-pr-15" },
    { PREVIEW_RELEASE: "kq-pr-150" }, { PREVIEW_PR: "15\n" },
    { PREVIEW_PR: "15;exit" }, { GITHUB_REPOSITORY: "example/project\n" },
  ])("rejects inconsistent scope before invoking commands: %j", (override) => {
    const cluster = mockCluster();
    expect(() => runCLI(["cleanup"], { ...environment(), ...override }, cluster.run)).toThrow();
    expect(cluster.calls).toEqual([]);
  });

  test("creates separate markers and reuses complete credentials when a failed deployment retries", () => {
    const scope = previewScope(environment());
    const other = previewScope(environment("150"));
    const cluster = mockCluster();
    expect(prepare(scope, cluster.run)).toBeNull();
    expect(prepare(other, cluster.run)).toBeNull();
    const secret = fixtures(scope).secret;
    applyCredentials(scope, secret, cluster.run);
    // Helm --atomic may remove a failed install while leaving these external resources.
    expect(prepare(scope, cluster.run)).toEqual(secret);
    expect(prepare(other, cluster.run)).toBeNull();
    expect(cluster.items.filter((entry) => entry.kind === "ConfigMap").map(
      (entry) => entry.metadata.name,
    )).toEqual([scope.marker, other.marker]);
    expect(cluster.calls.filter((call) => call.args[2] === "create")).toHaveLength(2);
  });

  test("prepares mode-0600 previous-secret JSON without printing credentials", () => {
    const scope = previewScope(environment());
    const { marker, secret } = fixtures(scope);
    const cluster = mockCluster([marker, secret]);
    const writes = [];
    runCLI(["prepare", "/mock/previous-secret"], environment(), cluster.run, {
      writeFileSync: (...args) => writes.push(args),
    });
    expect(writes).toEqual([["/mock/previous-secret", JSON.stringify(secret), { mode: 0o600 }]]);
    expect(mutations(cluster)).toEqual([]);
  });

  test.each(["marker", "secret"])("rejects missing or foreign %s ownership before any mutation", (key) => {
    for (const field of [MANAGER, INSTANCE, PR, REPOSITORY, "namespace"]) {
      for (const missing of [true, false]) {
        const scope = previewScope(environment());
        const values = fixtures(scope);
        const metadata = values[key].metadata;
        const map = field === REPOSITORY ? metadata.annotations :
          field === "namespace" ? metadata : metadata.labels;
        if (missing) delete map[field];
        else map[field] = "foreign";
        for (const operation of [prepare, cleanup]) {
          const cluster = mockCluster(
            [values.marker, values.secret, values.claim, values.workload], [values.release],
          );
          expect(() => operation(scope, cluster.run)).toThrow();
          expect(mutations(cluster)).toEqual([]);
        }
      }
    }
  });

  test("does not adopt a pre-existing release or unmarked residual claims", () => {
    const scope = previewScope(environment());
    const { release, claim } = fixtures(scope);
    for (const [items, releases] of [[[], [release]], [[claim], []]]) {
      const cluster = mockCluster(items, releases);
      expect(() => prepare(scope, cluster.run)).toThrow("owned release marker");
      expect(() => cleanup(scope, cluster.run)).toThrow("owned release marker");
      expect(mutations(cluster)).toEqual([]);
    }
  });

  test("does not regenerate credentials while persistent state still exists", () => {
    const scope = previewScope(environment());
    const { marker, claim } = fixtures(scope);
    const cluster = mockCluster([marker, claim]);
    expect(() => prepare(scope, cluster.run)).toThrow("requires its original credentials");
    expect(mutations(cluster)).toEqual([]);
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual([]);
  });

  test("retained claim templates require preview PR and repository metadata", () => {
    const scope = previewScope(environment());
    const { marker, claim } = fixtures(scope);
    claim.metadata.labels[MANAGER] = "Helm";
    delete claim.metadata.labels[PR];
    delete claim.metadata.annotations[REPOSITORY];
    const cluster = mockCluster([marker, claim]);
    expect(() => cleanup(scope, cluster.run)).toThrow("ownership mismatch");
    expect(mutations(cluster)).toEqual([]);
  });

  test("claims require exact namespace, manager, instance, PR and repository", () => {
    const scope = previewScope(environment());
    for (const field of [MANAGER, INSTANCE, "namespace", PR, REPOSITORY]) {
      for (const missing of [true, false]) {
        const { marker, claim, release } = fixtures(scope);
        const metadata = claim.metadata;
        const map = field === REPOSITORY ? metadata.annotations :
          field === "namespace" ? metadata : metadata.labels;
        if (missing) delete map[field];
        else map[field] = "foreign";
        const cluster = mockCluster([marker, claim], [release]);
        expect(() => cleanup(scope, cluster.run)).toThrow("ownership mismatch");
        expect(mutations(cluster)).toEqual([]);
      }
    }
  });

  test("refuses a foreign Helm object even when the preview marker is valid", () => {
    const scope = previewScope(environment());
    const { marker, workload, release } = fixtures(scope);
    workload.metadata.annotations["meta.helm.sh/release-name"] = "kq-pr-150";
    const cluster = mockCluster([marker, workload], [release]);
    expect(() => cleanup(scope, cluster.run)).toThrow("Helm resource ownership");
    expect(mutations(cluster)).toEqual([]);
  });

  test.each(["Pod", "ReplicaSet", "ControllerRevision"])("controller child %s needs instance, not Helm object metadata", (kind) => {
    const scope = previewScope(environment());
    const { marker, secret, release } = fixtures(scope);
    const child = object(scope, kind, `${scope.release}-server-child`);
    child.metadata.labels = { [INSTANCE]: scope.release };
    child.metadata.annotations = {};
    const cluster = mockCluster([marker, secret, child], [release]);
    expect(prepare(scope, cluster.run)).toEqual(secret);
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual([]);
  });

  test("refuses foreign release storage and unknown claim names", () => {
    const scope = previewScope(environment());
    const { marker, storage, release } = fixtures(scope);
    storage.metadata.labels.name = "kq-pr-150";
    const unknownClaim = object(scope, "PersistentVolumeClaim", `${scope.release}-unrecognized`);
    for (const invalid of [storage, unknownClaim]) {
      const cluster = mockCluster([marker, invalid], [release]);
      expect(() => cleanup(scope, cluster.run)).toThrow();
      expect(mutations(cluster)).toEqual([]);
    }
  });

  test("rejects a foreign Pod referencing the target claim before uninstall", () => {
    const scope = previewScope(environment());
    const { marker, claim, release } = fixtures(scope);
    const pod = object(previewScope(environment("150")), "Pod", "kq-pr-150-reader");
    pod.spec = { volumes: [{ persistentVolumeClaim: { claimName: claim.metadata.name } }] };
    const cluster = mockCluster([marker, claim, pod], [release]);
    expect(() => cleanup(scope, cluster.run)).toThrow("foreign workload");
    expect(mutations(cluster)).toEqual([]);
  });

  test("uninstalls only PR15, waits, then removes exact residuals and leaves PR150 untouched", () => {
    const scope = previewScope(environment());
    const other = previewScope(environment("150"));
    const own = fixtures(scope);
    const foreign = fixtures(other);
    const foreignItems = [foreign.marker, foreign.secret, foreign.claim, foreign.workload, foreign.storage];
    const cluster = mockCluster(
      [own.marker, own.secret, own.claim, own.workload, own.storage, ...foreignItems],
      [own.release, foreign.release],
    );
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual(foreignItems);
    expect(cluster.releases).toEqual([foreign.release]);
    const changes = mutations(cluster);
    expect(changes[0].args).toEqual([
      "uninstall", scope.release, "-n", "preview", "--wait", "--timeout", "5m", "--cascade", "foreground",
    ]);
    expect(changes.slice(1).map((call) => call.args.slice(2, 5))).toEqual([
      ["delete", "--raw", `/api/v1/namespaces/preview/persistentvolumeclaims/${own.claim.metadata.name}`],
      ["delete", "--raw", `/api/v1/namespaces/preview/secrets/${scope.secret}`],
      ["delete", "--raw", `/api/v1/namespaces/preview/configmaps/${scope.marker}`],
    ]);
    expect(changes.slice(1).map((call) => JSON.parse(call.input).preconditions)).toEqual(
      [own.claim, own.secret, own.marker].map((entry) => ({
        uid: entry.metadata.uid, resourceVersion: entry.metadata.resourceVersion,
      })),
    );
  });

  test("cleans partial release leftovers without a Helm release and supports repeated cleanup", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    const cluster = mockCluster([marker, secret, claim]);
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual([]);
    const first = mutations(cluster).length;
    cleanup(scope, cluster.run);
    expect(mutations(cluster)).toHaveLength(first);
    expect(cluster.calls.some((call) => call.args[0] === "uninstall")).toBe(false);
  });

  test.each(["agent", "registry-blobs"])("cleans an owned standalone %s PVC left by partial uninstall", (suffix) => {
    const scope = previewScope(environment());
    const claim = object(scope, "PersistentVolumeClaim", `${scope.release}-${suffix}`, true);
    const cluster = mockCluster([fixtures(scope).marker, claim]);
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual([]);
  });

  test("failed Helm uninstall blocks all residual deletion and propagates failure", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim, release } = fixtures(scope);
    const cluster = mockCluster([marker, secret, claim], [release], { uninstallError: true });
    expect(() => cleanup(scope, cluster.run)).toThrow("mock Helm failure");
    expect(mutations(cluster)).toHaveLength(1);
    expect(cluster.items).toEqual([marker, secret, claim]);
  });

  test("surviving Pods after uninstall prevent PVC, Secret and marker deletion", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim, release } = fixtures(scope);
    const pod = object(scope, "Pod", `${scope.release}-postgres-0`);
    const cluster = mockCluster([marker, secret, claim, pod], [release], {
      keepAfterUninstall: pod.metadata.name,
    });
    const waits = [];
    expect(() => cleanup(scope, cluster.run, (milliseconds) => waits.push(milliseconds)))
      .toThrow("removal is incomplete");
    expect(waits).toEqual(Array(12).fill(5000));
    expect(cluster.calls.some((call) => call.args[2] === "delete")).toBe(false);
  });

  test("waits for controller children to disappear before deleting retained claims", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim, release } = fixtures(scope);
    const pod = object(scope, "Pod", `${scope.release}-postgres-0`);
    const cluster = mockCluster([marker, secret, claim, pod], [release], {
      keepAfterUninstall: pod.metadata.name,
    });
    const waits = [];
    cleanup(scope, cluster.run, (milliseconds) => {
      expect(cluster.calls.some((call) => call.args[2] === "delete")).toBe(false);
      waits.push(milliseconds);
      cluster.items = cluster.items.filter((entry) => entry.kind !== "Pod");
    });
    expect(waits).toEqual([5000]);
    expect(cluster.items).toEqual([]);
  });

  test("partial PVC cleanup failure preserves credentials and marker for a later retry", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    const second = object(scope, "PersistentVolumeClaim", `data-${scope.release}-redis-0`);
    const options = { deleteFailure: second.metadata.name };
    const cluster = mockCluster([marker, secret, claim, second], [], options);
    expect(() => cleanup(scope, cluster.run)).toThrow("mock delete failure");
    expect(cluster.items).toEqual([marker, secret, second]);
    delete options.deleteFailure;
    cleanup(scope, cluster.run);
    expect(cluster.items).toEqual([]);
  });

  test("a replaced PVC between inventory and deletion is never deleted", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    const cluster = mockCluster([marker, secret, claim], [], {
      before: ({ command, args }, state) => {
        if (command === "kubectl" && args[2] === "get" && args[3] === "PersistentVolumeClaim") {
          state.items.find((entry) => entry.kind === "PersistentVolumeClaim").metadata.uid = "replacement";
        }
      },
    });
    expect(() => cleanup(scope, cluster.run)).toThrow("changed after ownership preflight");
    expect(mutations(cluster)).toEqual([]);
  });

  test.each(["uid", "resourceVersion"])("the API rejects %s changes after the final GET without deleting credentials or marker", (field) => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    const cluster = mockCluster([marker, secret, claim], [], {
      before: ({ command, args }, state) => {
        if (command === "kubectl" && args[2] === "delete") {
          state.items.find((entry) => entry.kind === "PersistentVolumeClaim").metadata[field] = "replacement";
        }
      },
    });
    expect(() => cleanup(scope, cluster.run)).toThrow("409 Conflict");
    expect(cluster.items.map((entry) => entry.metadata.name)).toEqual([
      scope.marker, scope.secret, claim.metadata.name,
    ]);
    expect(mutations(cluster)).toHaveLength(1);
    expect(JSON.parse(mutations(cluster)[0].input).preconditions).toEqual({
      uid: claim.metadata.uid, resourceVersion: claim.metadata.resourceVersion,
    });
  });

  test("raw deletion waits for finalizers before deleting credentials and marker", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    const cluster = mockCluster([marker, secret, claim], [], { keepTerminating: claim.metadata.name });
    const waits = [];
    cleanup(scope, cluster.run, (milliseconds) => {
      expect(mutations(cluster)).toHaveLength(1);
      waits.push(milliseconds);
      cluster.items = cluster.items.filter((entry) => entry.kind !== "PersistentVolumeClaim");
    });
    expect(waits).toEqual([5000]);
    expect(cluster.items).toEqual([]);
  });

  test("a replacement observed after raw deletion fails closed without deleting the replacement", () => {
    const scope = previewScope(environment());
    const { marker, secret, claim } = fixtures(scope);
    let sent = false;
    const cluster = mockCluster([marker, secret, claim], [], {
      before: ({ command, args }, state) => {
        if (command === "kubectl" && args[2] === "delete") sent = true;
        if (sent && args[2] === "get" && args[3] === "PersistentVolumeClaim") {
          state.items.push({ ...claim, metadata: { ...claim.metadata, uid: "replacement" } });
        }
      },
    });
    expect(() => cleanup(scope, cluster.run)).toThrow("replaced while waiting");
    expect(mutations(cluster)).toHaveLength(1);
    expect(cluster.items.map((entry) => entry.metadata.name)).toEqual([
      scope.marker, scope.secret, claim.metadata.name,
    ]);
  });

  test("namespace-only API failures are not treated as an absent release", () => {
    const scope = previewScope(environment());
    const cluster = mockCluster([], [], { inventoryError: true });
    expect(() => cleanup(scope, cluster.run)).toThrow("mock RBAC denied");
    expect(mutations(cluster)).toEqual([]);
  });

  test("credentials cannot be installed without an owned marker or with foreign metadata", () => {
    const scope = previewScope(environment());
    const { marker, secret } = fixtures(scope);
    const empty = mockCluster();
    expect(() => applyCredentials(scope, secret, empty.run)).toThrow("owned release marker");
    expect(mutations(empty)).toEqual([]);
    secret.metadata.annotations[REPOSITORY] = "foreign/project";
    const cluster = mockCluster([marker]);
    expect(() => applyCredentials(scope, secret, cluster.run)).toThrow("ownership mismatch");
    expect(mutations(cluster)).toEqual([]);
  });

  test("remote uses namespaced reachability and the complete release credential handoff", () => {
    const script = readFileSync(join(__dirname, "remote.sh"), "utf8");
    expect(script).toContain('export PREVIEW_NAMESPACE="preview"');
    expect(script).toContain('export PREVIEW_RELEASE="kq-pr-$PREVIEW_PR"');
    expect(script).toContain('get configmap "$release-preview-owner"');
    expect(script).toContain('node "$tooling/resources.cjs" prepare "$state/previous-secret"');
    expect(script).toContain('node "$tooling/credentials.cjs" "$state/previous-secret" "$state/secret"');
    expect(script).toContain('node "$tooling/resources.cjs" credentials "$state/secret"');
    expect(script).toContain('helm upgrade --install "$release" "$chart" -n "$namespace"');
    expect(script).toContain('node "$tooling/resources.cjs" cleanup');
    expect(script).not.toMatch(/\b(get|create|delete|annotate)\s+(namespace|namespaces|nodes)\b/);
    expect(script).not.toContain("--raw=/readyz");
    expect(script).not.toContain("--create-namespace");
  });
});
