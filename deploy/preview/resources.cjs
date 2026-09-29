const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const NAMESPACE = "preview";
const INSTANCE = "app.kubernetes.io/instance";
const MANAGER = "app.kubernetes.io/managed-by";
const PR = "kuintessence.com/preview-pr";
const REPOSITORY = "kuintessence.com/repository";
const INVENTORY = [
  "configmaps", "secrets", "persistentvolumeclaims", "statefulsets", "deployments",
  "services", "jobs", "pods", "replicasets", "controllerrevisions", "serviceaccounts", "roles",
  "rolebindings", "networkpolicies", "ingresses", "poddisruptionbudgets",
  "horizontalpodautoscalers",
].join(",");
const FAILURE_CODES = new Map([
  ["Invalid preview identity", "INVALID_IDENTITY"],
  ["Preview requires its PR release in the fixed preview namespace", "INVALID_SCOPE"],
  ["Preview resource ownership mismatch", "RESOURCE_OWNERSHIP_MISMATCH"],
  ["Helm resource ownership mismatch", "HELM_OWNERSHIP_MISMATCH"],
  ["Unexpected preview claim name", "UNEXPECTED_CLAIM"],
  ["Invalid preview inventory", "INVALID_INVENTORY"],
  ["Existing preview resources require an owned release marker", "OWNER_MARKER_MISSING"],
  ["Unexpected preview credential type", "UNEXPECTED_CREDENTIAL_TYPE"],
  ["Helm release storage ownership mismatch", "HELM_STORAGE_MISMATCH"],
  ["Preview workload ownership mismatch", "WORKLOAD_OWNERSHIP_MISMATCH"],
  ["A foreign workload references a preview claim", "CLAIM_USED_BY_FOREIGN_WORKLOAD"],
  ["Existing preview state requires its original credentials", "ORIGINAL_CREDENTIALS_MISSING"],
  ["Unexpected preview credentials", "UNEXPECTED_CREDENTIALS"],
  ["Preview credentials require an owned release marker", "CREDENTIAL_OWNER_MARKER_MISSING"],
  ["Preview resource was replaced while waiting for deletion", "RESOURCE_REPLACED"],
  ["Preview resource deletion did not complete", "RESOURCE_DELETE_TIMEOUT"],
  ["Preview resource changed after ownership preflight", "RESOURCE_CHANGED"],
  ["Unexpected preview deletion kind", "UNEXPECTED_DELETE_KIND"],
  ["Preview release removal is incomplete", "RELEASE_REMOVAL_INCOMPLETE"],
  ["Preview residual cleanup is incomplete", "RESIDUAL_CLEANUP_INCOMPLETE"],
  ["Missing previous credential output", "CREDENTIAL_OUTPUT_MISSING"],
  ["Invalid preview resource operation", "INVALID_OPERATION"],
]);
const STAGES = new Set([
  "INVENTORY_READ", "INVENTORY_PARSE", "HELM_LIST", "HELM_LIST_PARSE",
  "OWNERSHIP_CHECK", "OWNER_CREATE", "CREDENTIAL_APPLY",
  "HELM_UNINSTALL", "RESOURCE_DELETE", "DELETE_WAIT",
]);
const RESOURCE_GROUPS = new Map([
  ["", ["configmaps", "secrets", "persistentvolumeclaims", "services", "pods", "serviceaccounts", "namespaces", "nodes"]],
  ["apps", ["statefulsets", "deployments", "replicasets", "controllerrevisions"]],
  ["batch", ["jobs"]],
  ["networking.k8s.io", ["networkpolicies", "ingresses"]],
  ["rbac.authorization.k8s.io", ["roles", "rolebindings"]],
  ["policy", ["poddisruptionbudgets"]],
  ["autoscaling", ["horizontalpodautoscalers"]],
].flatMap(([group, resources]) => resources.map((resource) => [resource, group])));

function atStage(stage, operation) {
  try {
    return operation();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Unknown preview failure");
    failure.previewStage = stage;
    throw failure;
  }
}

function diagnosticCode(error) {
  const known = FAILURE_CODES.get(error?.message);
  if (known) return known;
  if (error instanceof SyntaxError) return "INVALID_JSON_RESPONSE";
  if (error?.code === "ENOENT") return "COMMAND_OR_FILE_MISSING";
  if (error?.code === "ETIMEDOUT") return "COMMAND_TIMEOUT";
  const stderr = typeof error?.stderr === "string" || Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString("utf8") : "";
  if (/forbidden/i.test(stderr)) {
    const match = stderr.match(/cannot (get|list|watch|create|update|patch|delete) resource "([a-z]+)" in API group "([a-z.]*)"/);
    if (match && RESOURCE_GROUPS.has(match[2]) && RESOURCE_GROUPS.get(match[2]) === match[3]) {
      return `RBAC_DENIED verb=${match[1]} resource=${match[2]} group=${match[3] || "core"}`;
    }
    return "RBAC_DENIED";
  }
  if (/unauthorized|provide credentials/i.test(stderr)) return "API_UNAUTHORIZED";
  if (/doesn't have a resource type|no matches for kind/i.test(stderr)) return "API_RESOURCE_UNAVAILABLE";
  if (/x509:|certificate signed by unknown authority/i.test(stderr)) return "API_TLS_FAILURE";
  if (/connection refused|unable to connect|cluster unreachable|i\/o timeout/i.test(stderr)) return "API_UNREACHABLE";
  return "UNCLASSIFIED_FAILURE";
}

function diagnosticLine(error) {
  const stage = STAGES.has(error?.previewStage) ? error.previewStage : "LIFECYCLE";
  return `KQ_PREVIEW_RESOURCE_ERROR stage=${stage} code=${diagnosticCode(error)}`;
}

function previewScope(env) {
  const pr = env.PREVIEW_PR;
  const repository = env.GITHUB_REPOSITORY;
  if (typeof pr !== "string" || !/^[1-9][0-9]{0,14}$/.test(pr) || pr.trim() !== pr ||
      typeof repository !== "string" || repository.trim() !== repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid preview identity");
  }
  const release = `kq-pr-${pr}`;
  if (env.PREVIEW_NAMESPACE !== NAMESPACE || env.PREVIEW_RELEASE !== release) {
    throw new Error("Preview requires its PR release in the fixed preview namespace");
  }
  return {
    pr, repository, release, namespace: NAMESPACE,
    secret: `${release}-secrets`, marker: `${release}-preview-owner`,
  };
}

function ownerMetadata(scope, name) {
  return {
    name, namespace: scope.namespace,
    labels: { [MANAGER]: "kq-preview", [INSTANCE]: scope.release, [PR]: scope.pr },
    annotations: { [REPOSITORY]: scope.repository },
  };
}

function assertOwned(resource, scope, managers = ["kq-preview"]) {
  const { labels = {}, annotations = {} } = resource.metadata ?? {};
  if (resource.metadata?.namespace !== scope.namespace ||
      !managers.includes(labels[MANAGER]) || labels[INSTANCE] !== scope.release ||
      labels[PR] !== scope.pr || annotations[REPOSITORY] !== scope.repository) {
    throw new Error("Preview resource ownership mismatch");
  }
}

function targetResource(resource, scope) {
  const { name = "", labels = {} } = resource.metadata ?? {};
  return name === scope.release || name.startsWith(`${scope.release}-`) ||
    name.startsWith(`data-${scope.release}-`) ||
    name.startsWith(`sh.helm.release.v1.${scope.release}.`) ||
    labels[INSTANCE] === scope.release || labels[PR] === scope.pr;
}

function helmRecord(resource, scope) {
  return resource.kind === "Secret" &&
    resource.metadata?.name?.startsWith(`sh.helm.release.v1.${scope.release}.`);
}

function assertHelmResource(resource, scope) {
  const { labels = {}, annotations = {} } = resource.metadata ?? {};
  if (resource.metadata?.namespace !== scope.namespace ||
      labels[MANAGER] !== "Helm" || labels[INSTANCE] !== scope.release ||
      annotations["meta.helm.sh/release-name"] !== scope.release ||
      annotations["meta.helm.sh/release-namespace"] !== scope.namespace ||
      (labels[PR] !== undefined && labels[PR] !== scope.pr) ||
      (annotations[REPOSITORY] !== undefined && annotations[REPOSITORY] !== scope.repository)) {
    throw new Error("Helm resource ownership mismatch");
  }
}

function assertClaim(resource, scope) {
  const name = resource.metadata?.name;
  const stateful = new RegExp(`^data-${scope.release}-(postgres|redis|rustfs)-[0-9]+$`);
  if (name !== `${scope.release}-agent` && name !== `${scope.release}-registry-blobs` &&
      !stateful.test(name ?? "")) {
    throw new Error("Unexpected preview claim name");
  }
  assertOwned(resource, scope, ["kq-preview", "Helm"]);
}

function validateInventory(items, releases, scope) {
  if (!Array.isArray(items) || !Array.isArray(releases) || releases.length > 1 ||
      releases.some((release) => release.name !== scope.release || release.namespace !== scope.namespace)) {
    throw new Error("Invalid preview inventory");
  }
  const resources = items.filter((resource) => targetResource(resource, scope));
  const marker = resources.find((resource) =>
    resource.kind === "ConfigMap" && resource.metadata?.name === scope.marker);
  if (marker) assertOwned(marker, scope);
  if (!marker && (resources.length || releases.length)) {
    throw new Error("Existing preview resources require an owned release marker");
  }
  const claims = [];
  const remaining = [];
  let secret;
  for (const resource of resources) {
    if (resource === marker) continue;
    if (resource.kind === "Secret" && resource.metadata?.name === scope.secret) {
      assertOwned(resource, scope);
      if (resource.type !== "Opaque") throw new Error("Unexpected preview credential type");
      secret = resource;
    } else if (resource.kind === "PersistentVolumeClaim") {
      assertClaim(resource, scope);
      claims.push(resource);
    } else if (helmRecord(resource, scope)) {
      const { labels = {}, namespace } = resource.metadata;
      if (namespace !== scope.namespace || resource.type !== "helm.sh/release.v1" ||
          labels.owner !== "helm" || labels.name !== scope.release) {
        throw new Error("Helm release storage ownership mismatch");
      }
      remaining.push(resource);
    } else if (["Pod", "ReplicaSet", "ControllerRevision"].includes(resource.kind)) {
      // Controller children inherit the instance selector, not Helm's object annotations.
      const { labels = {}, annotations = {} } = resource.metadata ?? {};
      if (resource.metadata?.namespace !== scope.namespace ||
          labels[INSTANCE] !== scope.release ||
          (labels[PR] !== undefined && labels[PR] !== scope.pr) ||
          (annotations[REPOSITORY] !== undefined && annotations[REPOSITORY] !== scope.repository)) {
        throw new Error("Preview workload ownership mismatch");
      }
      remaining.push(resource);
    } else {
      assertHelmResource(resource, scope);
      remaining.push(resource);
    }
  }
  // A foreign Pod must never lose a claim that it currently references.
  const claimNames = new Set(claims.map((claim) => claim.metadata.name));
  const targets = new Set(resources);
  for (const resource of items) {
    if (resource.kind === "Pod" && !targets.has(resource) &&
        resource.spec?.volumes?.some((volume) => claimNames.has(volume.persistentVolumeClaim?.claimName))) {
      throw new Error("A foreign workload references a preview claim");
    }
  }
  return { marker, secret, claims, remaining, release: releases[0] };
}

function execute(command, args, input) {
  return execFileSync(command, args, {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    timeout: 360000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HELM_DRIVER: "secret" },
  });
}

function kubectl(run, scope, args, input) {
  return run("kubectl", ["-n", scope.namespace, ...args], input);
}

function inspect(run, scope) {
  const inventoryText = atStage("INVENTORY_READ", () =>
    kubectl(run, scope, ["get", INVENTORY, "-o", "json"]));
  const inventory = atStage("INVENTORY_PARSE", () => JSON.parse(inventoryText));
  const releaseText = atStage("HELM_LIST", () => run("helm", [
    "list", "-n", scope.namespace, "--all", "--filter", `^${scope.release}$`, "-o", "json",
  ]));
  const releases = atStage("HELM_LIST_PARSE", () => JSON.parse(releaseText));
  return atStage("OWNERSHIP_CHECK", () => validateInventory(inventory.items, releases, scope));
}

function prepare(scope, run = execute) {
  const current = inspect(run, scope);
  if (!current.secret && (current.release || current.claims.length || current.remaining.length)) {
    throw new Error("Existing preview state requires its original credentials");
  }
  if (!current.marker) {
    atStage("OWNER_CREATE", () => kubectl(run, scope, ["create", "-f", "-"], JSON.stringify({
      apiVersion: "v1", kind: "ConfigMap", metadata: ownerMetadata(scope, scope.marker),
      data: { release: scope.release, repository: scope.repository },
    })));
  }
  return current.secret ?? null;
}

function applyCredentials(scope, resource, run = execute) {
  if (resource.kind !== "Secret" || resource.type !== "Opaque" ||
      resource.metadata?.name !== scope.secret) {
    throw new Error("Unexpected preview credentials");
  }
  assertOwned(resource, scope);
  const current = inspect(run, scope);
  if (!current.marker) throw new Error("Preview credentials require an owned release marker");
  atStage("CREDENTIAL_APPLY", () =>
    kubectl(run, scope, ["apply", "--server-side", "--field-manager=kq-preview", "-f", "-"],
      JSON.stringify(resource)));
}

function readResource(scope, resource, run) {
  const text = kubectl(run, scope, [
    "get", resource.kind, resource.metadata.name, "--ignore-not-found", "-o", "json",
  ]);
  return text.trim() ? JSON.parse(text) : null;
}

function waitForDeletion(scope, resource, run, wait) {
  for (let attempt = 0; attempt < 61; attempt++) {
    const current = readResource(scope, resource, run);
    if (!current) return;
    if (current.metadata?.uid !== resource.metadata.uid) {
      throw new Error("Preview resource was replaced while waiting for deletion");
    }
    if (attempt < 60) wait(5000);
  }
  throw new Error("Preview resource deletion did not complete");
}

function deleteOwned(scope, resource, run, wait) {
  const current = readResource(scope, resource, run);
  if (!current) return;
  if (current.kind !== resource.kind || current.metadata?.name !== resource.metadata.name ||
      typeof resource.metadata.uid !== "string" || !resource.metadata.uid ||
      typeof resource.metadata.resourceVersion !== "string" || !resource.metadata.resourceVersion ||
      current.metadata?.uid !== resource.metadata.uid ||
      current.metadata?.resourceVersion !== resource.metadata.resourceVersion) {
    throw new Error("Preview resource changed after ownership preflight");
  }
  if (current.kind === "PersistentVolumeClaim") assertClaim(current, scope);
  else assertOwned(current, scope);
  const types = { PersistentVolumeClaim: "persistentvolumeclaims", Secret: "secrets", ConfigMap: "configmaps" };
  if (!Object.hasOwn(types, current.kind)) throw new Error("Unexpected preview deletion kind");
  const path = `/api/v1/namespaces/preview/${types[current.kind]}/${encodeURIComponent(current.metadata.name)}`;
  // kubectl v1.32 rawhttp.RawDelete passes stdin as the body, but does not wait for deletion.
  atStage("RESOURCE_DELETE", () => kubectl(run, scope, ["delete", "--raw", path, "-f", "-", "--request-timeout=30s"], JSON.stringify({
    apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground",
    preconditions: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
  })));
  atStage("DELETE_WAIT", () => waitForDeletion(scope, current, run, wait));
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForRemoval(scope, run, wait) {
  for (let attempt = 0; attempt < 13; attempt++) {
    const current = inspect(run, scope);
    if (!current.release && !current.remaining.length) return current;
    if (attempt < 12) wait(5000);
  }
  throw new Error("Preview release removal is incomplete");
}

function cleanup(scope, run = execute, wait = pause) {
  const before = inspect(run, scope);
  if (before.release) {
    atStage("HELM_UNINSTALL", () => run("helm", [
      "uninstall", scope.release, "-n", scope.namespace, "--wait", "--timeout", "5m",
      "--cascade", "foreground",
    ]));
  }
  const after = waitForRemoval(scope, run, wait);
  for (const claim of after.claims) deleteOwned(scope, claim, run, wait);
  if (after.secret) deleteOwned(scope, after.secret, run, wait);
  const last = inspect(run, scope);
  if (last.release || last.remaining.length || last.claims.length || last.secret) {
    throw new Error("Preview residual cleanup is incomplete");
  }
  if (last.marker) deleteOwned(scope, last.marker, run, wait);
}

function runCLI(args, env = process.env, run = execute, files = fs) {
  const [mode, file] = args;
  const scope = previewScope(env);
  if (mode === "prepare") {
    if (!file) throw new Error("Missing previous credential output");
    files.writeFileSync(file, JSON.stringify(prepare(scope, run)), { mode: 0o600 });
  } else if (mode === "credentials") {
    applyCredentials(scope, JSON.parse(files.readFileSync(file, "utf8")), run);
  } else if (mode === "cleanup") {
    cleanup(scope, run);
  } else {
    throw new Error("Invalid preview resource operation");
  }
}

if (require.main === module) {
  try {
    runCLI(process.argv.slice(2));
  } catch (error) {
    console.error(diagnosticLine(error));
    console.error("Preview resource lifecycle failed; ownership or removal could not be confirmed. No resource data was logged.");
    process.exitCode = 1;
  }
}

module.exports = { previewScope, ownerMetadata, prepare, applyCredentials, cleanup, runCLI, diagnosticCode, diagnosticLine };
