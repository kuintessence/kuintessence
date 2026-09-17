import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "@kuintessence/shared";
import {
  COMPUTE_HEALTH_CLI_TIMEOUT_MS,
  type ComputeHealthObservation,
  commandWithOptionalStdin,
  type JobResult,
  type JobSpec,
  type JobStatusResult,
  type KuintessenceJobLookup,
  type KuintessenceJobLookupResult,
  type ListedJob,
  observedComputeHealth,
  realSpawner,
  type SchedulerAdapter,
  type Spawner,
  sandboxInterpreter,
  shellQuote,
  unknownComputeHealth,
} from "./base";

const logger = createLogger("k8s-adapter");

interface K8sJobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function k8sNodeIsOperational(node: unknown): boolean | undefined {
  if (
    !isRecord(node) ||
    !isRecord(node.metadata) ||
    !isRecord(node.spec) ||
    !isRecord(node.status)
  ) {
    return undefined;
  }
  if (typeof node.metadata.name !== "string" || node.metadata.name.length === 0) return undefined;
  const unschedulable = node.spec.unschedulable;
  if (unschedulable !== undefined && typeof unschedulable !== "boolean") return undefined;
  const taints = node.spec.taints;
  if (taints !== undefined && !Array.isArray(taints)) return undefined;
  const hasBlockingTaint = (taints ?? []).some((taint) => {
    if (!isRecord(taint) || typeof taint.effect !== "string") return false;
    return taint.effect === "NoSchedule" || taint.effect === "NoExecute";
  });
  if ((taints ?? []).some((taint) => !isRecord(taint) || typeof taint.effect !== "string")) {
    return undefined;
  }
  const conditions = node.status.conditions;
  if (conditions !== undefined && !Array.isArray(conditions)) return undefined;
  if ((conditions ?? []).some((condition) => !isRecord(condition))) return undefined;
  const ready = (conditions ?? []).find((condition) => condition.type === "Ready");
  if (ready && typeof ready.status !== "string") return undefined;
  return ready?.status === "True" && !unschedulable && !hasBlockingTaint;
}

function parseK8sComputeHealth(
  output: string,
): { nodeCount: number; operationalNodeCount: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return undefined;

  let operationalNodeCount = 0;
  for (const node of parsed.items) {
    const operational = k8sNodeIsOperational(node);
    if (operational === undefined) return undefined;
    if (operational) operationalNodeCount += 1;
  }
  return { nodeCount: parsed.items.length, operationalNodeCount };
}

/** Map a K8s Job's status counts to a coarse status (succeeded > failed >
 *  active > pending), shared by status() and listJobs(). */
function mapK8sStatusName(status: K8sJobStatus): ListedJob["status"] {
  if ((status.succeeded ?? 0) > 0) return "completed";
  if ((status.failed ?? 0) > 0) return "failed";
  if ((status.active ?? 0) > 0) return "running";
  return "queued";
}

export interface K8sAdapterDeps {
  spawner?: Spawner;
  /** Kubernetes namespace to submit jobs into. */
  namespace?: string;
  /** Default container image. Can be overridden per-job via envVars. */
  defaultImage?: string;
  /** Override for the temp directory used to write manifest files. */
  tmpDir?: string;
  sandboxSeccompProfile?: {
    localhostProfile: string;
    nodeName: string;
    assertCurrent: () => Promise<void>;
  };
}

export class K8sAdapter implements SchedulerAdapter {
  readonly type = "kubernetes";
  private spawner: Spawner;
  private namespace: string;
  private defaultImage: string;
  private tmpDir: string;
  private sandboxSeccompProfile?: K8sAdapterDeps["sandboxSeccompProfile"];
  private jobNamespaces = new Map<string, string>();

  constructor(
    readonly version: string,
    deps: K8sAdapterDeps = {},
  ) {
    this.spawner = deps.spawner ?? realSpawner;
    this.namespace = deps.namespace ?? "default";
    this.defaultImage = deps.defaultImage ?? "busybox:latest";
    this.tmpDir = deps.tmpDir ?? tmpdir();
    this.sandboxSeccompProfile = deps.sandboxSeccompProfile;
  }

  /**
   * Build a Kubernetes batch/v1 Job manifest as a plain object.
   * The manifest is serialised as JSON and passed to `kubectl apply -f -`.
   */
  buildJobManifest(spec: JobSpec): Record<string, unknown> {
    if (spec.sandbox) return this.buildSandboxResources(spec);
    const env = Object.entries(spec.envVars).map(([name, value]) => ({ name, value }));
    const namespace = spec.queueName ?? this.namespace;

    const limits: Record<string, string> = {
      cpu: String(spec.cpus),
      memory: `${spec.memoryMb}Mi`,
    };
    if (spec.gpus > 0) {
      limits["nvidia.com/gpu"] = String(spec.gpus);
    }

    // Sanitise name: k8s labels must be DNS-safe lowercase
    const jobName = `kq-${spec.jobId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    const manifest: Record<string, unknown> = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace,
        labels: {
          "kuintessence.io/job-id": spec.jobId,
          "kuintessence.io/job-name": spec.schedulerName ?? spec.name,
          ...(spec.qos ? { "kuintessence.io/qos": spec.qos } : {}),
        },
      },
      spec: {
        backoffLimit: 0,
        ...(spec.wallTimeSec > 0 ? { activeDeadlineSeconds: spec.wallTimeSec } : {}),
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "kq-worker",
                image: this.defaultImage,
                command: ["/bin/sh", "-c", commandWithOptionalStdin(spec)],
                ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
                ...(env.length > 0 ? { env } : {}),
                resources: { limits, requests: limits },
              },
            ],
          },
        },
      },
    };

    return manifest;
  }

  private buildSandboxResources(spec: JobSpec): Record<string, unknown> {
    const sandbox = spec.sandbox;
    if (!sandbox) throw new Error("Sandbox specification is required");
    if (sandbox.runtimeKind !== "OCI" || !sandbox.runtimePath.includes("@sha256:")) {
      throw new Error("Kubernetes Sandbox requires a digest-pinned OCI image");
    }
    if (sandbox.identity.backend !== "Kubernetes") {
      throw new Error("Kubernetes Sandbox requires a Kubernetes execution account");
    }
    const sandboxSeccompProfile = this.requireSandboxSeccompProfile();
    if (spec.queueName && spec.queueName !== sandbox.identity.namespace) {
      throw new Error("Sandbox namespace does not match the selected queue");
    }
    const pvcMounts = sandbox.mounts.filter(
      (mount) => mount.mode === "WriteOnly" || !mount.inlineContentBase64,
    );
    if (pvcMounts.length > 0 && !sandbox.kubernetesArtifactPvc) {
      throw new Error("Kubernetes Sandbox artifact mounts require a managed PVC");
    }
    const jobName = `kq-${spec.jobId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const scriptConfigName = `${jobName}-script`;
    const labels = {
      "kuintessence.io/job-id": spec.jobId,
      "kuintessence.io/sandbox": "true",
    };
    const limits: Record<string, string> = {
      cpu: String(spec.cpus),
      memory: `${spec.memoryMb}Mi`,
    };
    if (spec.gpus > 0) limits["nvidia.com/gpu"] = String(spec.gpus);
    const artifactMounts = sandbox.mounts.map((mount) => ({
      name: mount.mode === "ReadOnly" && mount.inlineContentBase64 ? "script" : "artifacts",
      mountPath: mount.containerPath,
      subPath:
        mount.mode === "ReadOnly" && mount.inlineContentBase64
          ? `input-${mount.descriptor}`
          : mount.relativePath,
      readOnly: mount.mode === "ReadOnly",
    }));
    const volumes: Record<string, unknown>[] = [
      { name: "script", configMap: { name: scriptConfigName, defaultMode: 0o444 } },
      { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
    ];
    if (pvcMounts.length > 0) {
      volumes.push({
        name: "artifacts",
        persistentVolumeClaim: { claimName: sandbox.kubernetesArtifactPvc },
      });
    }
    return {
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: `${jobName}-deny-network`, namespace: sandbox.identity.namespace },
          spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"] },
        },
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: scriptConfigName, namespace: sandbox.identity.namespace },
          data: {
            [sandbox.entrypoint]: sandbox.scriptContent,
            "context.json": JSON.stringify({
              jobId: spec.jobId,
              inputs: Object.fromEntries(
                sandbox.mounts
                  .filter((mount) => mount.mode === "ReadOnly")
                  .map((mount) => [
                    mount.descriptor,
                    { type: mount.ioType, path: mount.containerPath },
                  ]),
              ),
              outputs: Object.fromEntries(
                sandbox.mounts
                  .filter((mount) => mount.mode === "WriteOnly")
                  .map((mount) => [
                    mount.descriptor,
                    { type: mount.ioType, path: mount.containerPath },
                  ]),
              ),
            }),
          },
          binaryData: Object.fromEntries(
            sandbox.mounts
              .filter(
                (mount) => mount.mode === "ReadOnly" && mount.inlineContentBase64 !== undefined,
              )
              .map((mount) => [`input-${mount.descriptor}`, mount.inlineContentBase64]),
          ),
        },
        {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: jobName, namespace: sandbox.identity.namespace, labels },
          spec: {
            backoffLimit: 0,
            ...(spec.wallTimeSec > 0 ? { activeDeadlineSeconds: spec.wallTimeSec } : {}),
            template: {
              metadata: { labels },
              spec: {
                restartPolicy: "Never",
                serviceAccountName: sandbox.identity.serviceAccount,
                automountServiceAccountToken: false,
                nodeName: sandboxSeccompProfile.nodeName,
                securityContext: {
                  runAsNonRoot: true,
                  seccompProfile: {
                    type: "Localhost",
                    localhostProfile: sandboxSeccompProfile.localhostProfile,
                  },
                },
                containers: [
                  {
                    name: "kq-sandbox",
                    image: sandbox.runtimePath,
                    command: [
                      "/bin/bash",
                      "-o",
                      "pipefail",
                      "-c",
                      `ulimit -u ${sandbox.limits.pids}; ${shellQuote(sandboxInterpreter(sandbox.language))} ${shellQuote(`/kq/script/${sandbox.entrypoint}`)} 2>&1 | head -c ${sandbox.limits.logBytes}`,
                    ],
                    workingDir: "/kq",
                    securityContext: {
                      allowPrivilegeEscalation: false,
                      readOnlyRootFilesystem: true,
                      capabilities: { drop: ["ALL"] },
                    },
                    resources: { limits, requests: limits },
                    volumeMounts: [
                      { name: "script", mountPath: "/kq/script", readOnly: true },
                      {
                        name: "script",
                        mountPath: "/kq/context.json",
                        subPath: "context.json",
                        readOnly: true,
                      },
                      { name: "tmp", mountPath: "/tmp" },
                      ...artifactMounts,
                    ],
                  },
                ],
                volumes,
              },
            },
          },
        },
      ],
    };
  }

  async submit(spec: JobSpec): Promise<JobResult> {
    if (spec.sandbox) await this.requireSandboxSeccompProfile().assertCurrent();
    const manifest = this.buildJobManifest(spec);
    const manifestJson = JSON.stringify(manifest, null, 2);

    const manifestPath = join(this.tmpDir, `kq-k8s-${spec.jobId}.json`);
    await writeFile(manifestPath, manifestJson);

    const { exitCode, stderr } = await this.spawner.run([
      "kubectl",
      "apply",
      "-f",
      manifestPath,
      "-n",
      spec.sandbox?.identity.backend === "Kubernetes"
        ? spec.sandbox.identity.namespace
        : (spec.queueName ?? this.namespace),
    ]);
    if (exitCode !== 0) {
      throw new Error(`kubectl apply failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    const jobResource =
      manifest.kind === "List"
        ? (manifest.items as Array<Record<string, unknown>>).find((item) => item.kind === "Job")
        : manifest;
    const jobName = (jobResource?.metadata as { name?: string } | undefined)?.name;
    if (!jobName) throw new Error("Kubernetes manifest did not contain a Job resource");
    const namespace =
      spec.sandbox?.identity.backend === "Kubernetes"
        ? spec.sandbox.identity.namespace
        : (spec.queueName ?? this.namespace);
    this.jobNamespaces.set(jobName, namespace);
    logger.info(
      {
        jobId: spec.jobId,
        jobName,
        namespace,
      },
      "Job submitted to Kubernetes",
    );
    return { schedulerJobId: jobName };
  }

  async cancel(schedulerJobId: string): Promise<void> {
    const namespace = this.namespaceFor(schedulerJobId);
    const { exitCode, stderr } = await this.spawner.run([
      "kubectl",
      "delete",
      "job",
      schedulerJobId,
      "-n",
      namespace,
      "--ignore-not-found",
    ]);
    if (exitCode !== 0) {
      throw new Error(`kubectl delete failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    this.jobNamespaces.delete(schedulerJobId);
  }

  async inspectComputeHealth(): Promise<ComputeHealthObservation> {
    try {
      const result = await this.spawner.run(["kubectl", "get", "nodes", "-o", "json"], {
        timeoutMs: COMPUTE_HEALTH_CLI_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return unknownComputeHealth("scheduler_command_failed");
      const parsed = parseK8sComputeHealth(result.stdout);
      return parsed
        ? observedComputeHealth(parsed.nodeCount, parsed.operationalNodeCount)
        : unknownComputeHealth("invalid_scheduler_state");
    } catch {
      return unknownComputeHealth("scheduler_command_failed");
    }
  }

  async findByKuintessenceJobId(
    lookup: KuintessenceJobLookup,
  ): Promise<KuintessenceJobLookupResult> {
    const namespace = lookup.namespace ?? this.namespace;
    try {
      const { exitCode, stdout, stderr } = await this.spawner.run([
        "kubectl",
        "get",
        "jobs",
        "-n",
        namespace,
        "-l",
        `kuintessence.io/job-id=${lookup.jobId}`,
        "-o",
        "json",
      ]);
      if (exitCode !== 0) {
        return { status: "indeterminate", reason: `kubectl get jobs failed: ${stderr.trim()}` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return { status: "indeterminate", reason: "kubectl returned non-JSON output" };
      }
      const data = parsed as { items?: Array<{ metadata?: { name?: string } }> };
      const names = (data.items ?? [])
        .map((item) => item.metadata?.name)
        .filter((name): name is string => !!name);
      if (names.length === 0) return { status: "not_found" };
      if (names.length !== 1) {
        return {
          status: "indeterminate",
          reason: "multiple Kubernetes jobs share Kuintessence UUID",
        };
      }
      const schedulerJobId = names[0];
      if (!schedulerJobId) {
        return {
          status: "indeterminate",
          reason: "Kubernetes lookup returned an invalid job name",
        };
      }
      this.jobNamespaces.set(schedulerJobId, namespace);
      return { status: "found", schedulerJobId };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : "Kubernetes lookup failed",
      };
    }
  }

  async listJobs(): Promise<ListedJob[]> {
    const { exitCode, stdout, stderr } = await this.spawner.run([
      "kubectl",
      "get",
      "jobs",
      "-n",
      this.namespace,
      "-o",
      "json",
    ]);
    if (exitCode !== 0) {
      throw new Error(`kubectl get jobs failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    if (!stdout.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("kubectl returned non-JSON output");
    }
    const data = parsed as {
      items?: Array<{ metadata?: { name?: string }; status?: K8sJobStatus }>;
    };
    return (data.items ?? []).map((item) => {
      const name = item.metadata?.name ?? "";
      return {
        schedulerJobId: name,
        name,
        status: mapK8sStatusName(item.status ?? {}),
        queue: this.namespace,
      };
    });
  }

  async getJobLogs(schedulerJobId: string, lines: number): Promise<string> {
    const namespace = this.namespaceFor(schedulerJobId);
    const { exitCode, stdout, stderr } = await this.spawner.run([
      "kubectl",
      "logs",
      `job/${schedulerJobId}`,
      "-n",
      namespace,
      `--tail=${lines}`,
    ]);
    if (exitCode !== 0) {
      throw new Error(`kubectl logs failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    return stdout;
  }

  async stageSandboxInputs(sandbox: NonNullable<JobSpec["sandbox"]>, jobId: string) {
    const inputs = sandbox.mounts.filter(
      (mount) => mount.mode === "ReadOnly" && !mount.inlineContentBase64,
    );
    if (inputs.length === 0) return;
    if (
      sandbox.runtimeKind !== "OCI" ||
      sandbox.identity.backend !== "Kubernetes" ||
      !sandbox.kubernetesArtifactPvc
    ) {
      throw new Error("Kubernetes Sandbox input stager requires OCI and a managed PVC");
    }
    const namespace = sandbox.identity.namespace;
    const sandboxSeccompProfile = this.requireSandboxSeccompProfile();
    await sandboxSeccompProfile.assertCurrent();
    const stagerName = `kq-${jobId}-stage`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63)
      .replace(/-+$/g, "");
    const networkPolicyName = `${stagerName}-deny-network`.slice(0, 63).replace(/-+$/g, "");
    const labels = {
      "kuintessence.io/job-id": jobId,
      "kuintessence.io/sandbox": "true",
      "kuintessence.io/stager": "true",
    };
    const manifest = {
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: networkPolicyName, namespace },
          spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"] },
        },
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: stagerName, namespace, labels },
          spec: {
            restartPolicy: "Never",
            serviceAccountName: sandbox.identity.serviceAccount,
            automountServiceAccountToken: false,
            nodeName: sandboxSeccompProfile.nodeName,
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: {
                type: "Localhost",
                localhostProfile: sandboxSeccompProfile.localhostProfile,
              },
            },
            containers: [
              {
                name: "stager",
                image: sandbox.runtimePath,
                command: ["/bin/sh", "-c", "sleep 300"],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { cpu: "100m", memory: "128Mi" },
                },
                volumeMounts: [
                  { name: "artifacts", mountPath: "/artifacts" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              {
                name: "artifacts",
                persistentVolumeClaim: { claimName: sandbox.kubernetesArtifactPvc },
              },
              { name: "tmp", emptyDir: { sizeLimit: "32Mi" } },
            ],
          },
        },
      ],
    };
    const manifestPath = join(this.tmpDir, `${stagerName}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    try {
      const apply = await this.spawner.run([
        "kubectl",
        "apply",
        "-f",
        manifestPath,
        "-n",
        namespace,
      ]);
      if (apply.exitCode !== 0) {
        throw new Error(`Kubernetes Sandbox input stager create failed: ${apply.stderr.trim()}`);
      }
      const ready = await this.spawner.run([
        "kubectl",
        "wait",
        `pod/${stagerName}`,
        "--for=condition=Ready",
        "--timeout=60s",
        "-n",
        namespace,
      ]);
      if (ready.exitCode !== 0) {
        throw new Error(`Kubernetes Sandbox input stager was not ready: ${ready.stderr.trim()}`);
      }
      for (const mount of inputs) {
        const targetPath = `/artifacts/${mount.relativePath}`;
        const directory = mount.ioType === "FileBatch" ? targetPath : dirname(targetPath);
        const prepared = await this.spawner.run([
          "kubectl",
          "exec",
          stagerName,
          "-n",
          namespace,
          "-c",
          "stager",
          "--",
          "mkdir",
          "-p",
          directory,
        ]);
        if (prepared.exitCode !== 0) {
          throw new Error(
            `Kubernetes Sandbox input directory create failed: ${prepared.stderr.trim()}`,
          );
        }
        const sourcePath = mount.ioType === "FileBatch" ? `${mount.hostPath}/.` : mount.hostPath;
        const copied = await this.spawner.run([
          "kubectl",
          "cp",
          sourcePath,
          `${namespace}/${stagerName}:${targetPath}`,
          "-c",
          "stager",
        ]);
        if (copied.exitCode !== 0) {
          throw new Error(
            `Kubernetes Sandbox input copy failed for ${mount.descriptor}: ${copied.stderr.trim()}`,
          );
        }
      }
    } finally {
      await this.spawner.run([
        "kubectl",
        "delete",
        `pod/${stagerName}`,
        `networkpolicy/${networkPolicyName}`,
        "--ignore-not-found",
        "-n",
        namespace,
      ]);
      await rm(manifestPath, { force: true });
    }
  }

  async stageSandboxOutputs(sandbox: NonNullable<JobSpec["sandbox"]>, schedulerJobId: string) {
    if (!sandbox.mounts.some((mount) => mount.mode === "WriteOnly")) return;
    if (
      sandbox.runtimeKind !== "OCI" ||
      sandbox.identity.backend !== "Kubernetes" ||
      !sandbox.kubernetesArtifactPvc
    ) {
      throw new Error(
        "Kubernetes Sandbox collector requires OCI, mapped identity, and managed PVC",
      );
    }
    const collectorName = `${schedulerJobId}-collector`.slice(0, 63).replace(/-+$/g, "");
    const namespace = sandbox.identity.namespace;
    const sandboxSeccompProfile = this.requireSandboxSeccompProfile();
    await sandboxSeccompProfile.assertCurrent();
    const labels = {
      "kuintessence.io/job-id": schedulerJobId.replace(/^kq-/, ""),
      "kuintessence.io/sandbox": "true",
      "kuintessence.io/collector": "true",
    };
    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: collectorName, namespace, labels },
      spec: {
        restartPolicy: "Never",
        serviceAccountName: sandbox.identity.serviceAccount,
        automountServiceAccountToken: false,
        nodeName: sandboxSeccompProfile.nodeName,
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: {
            type: "Localhost",
            localhostProfile: sandboxSeccompProfile.localhostProfile,
          },
        },
        containers: [
          {
            name: "collector",
            image: sandbox.runtimePath,
            command: ["/bin/sh", "-c", "sleep 300"],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "100m", memory: "128Mi" },
            },
            volumeMounts: [
              { name: "artifacts", mountPath: "/artifacts", readOnly: true },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          {
            name: "artifacts",
            persistentVolumeClaim: { claimName: sandbox.kubernetesArtifactPvc, readOnly: true },
          },
          { name: "tmp", emptyDir: { sizeLimit: "32Mi" } },
        ],
      },
    };
    const manifestPath = join(this.tmpDir, `${collectorName}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    try {
      const apply = await this.spawner.run([
        "kubectl",
        "apply",
        "-f",
        manifestPath,
        "-n",
        namespace,
      ]);
      if (apply.exitCode !== 0) {
        throw new Error(`Kubernetes Sandbox collector create failed: ${apply.stderr.trim()}`);
      }
      const ready = await this.spawner.run([
        "kubectl",
        "wait",
        `pod/${collectorName}`,
        "--for=condition=Ready",
        "--timeout=60s",
        "-n",
        namespace,
      ]);
      if (ready.exitCode !== 0) {
        throw new Error(
          `Kubernetes Sandbox collector did not become ready: ${ready.stderr.trim()}`,
        );
      }
      for (const mount of sandbox.mounts.filter((item) => item.mode === "WriteOnly")) {
        await mkdir(dirname(mount.hostPath), { recursive: true });
        const copied = await this.spawner.run([
          "kubectl",
          "cp",
          `${namespace}/${collectorName}:/artifacts/${mount.relativePath}`,
          mount.hostPath,
          "-c",
          "collector",
        ]);
        if (copied.exitCode !== 0) {
          throw new Error(
            `Kubernetes Sandbox output copy failed for ${mount.descriptor}: ${copied.stderr.trim()}`,
          );
        }
      }
    } finally {
      await this.spawner.run([
        "kubectl",
        "delete",
        "pod",
        collectorName,
        "--ignore-not-found",
        "-n",
        namespace,
      ]);
      await rm(manifestPath, { force: true });
    }
  }

  async status(schedulerJobId: string): Promise<JobStatusResult> {
    const namespace = this.namespaceFor(schedulerJobId);
    const { exitCode, stdout } = await this.spawner.run([
      "kubectl",
      "get",
      "job",
      schedulerJobId,
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    if (exitCode !== 0 || !stdout.trim()) {
      return { status: "failed", message: "kubectl get returned no data" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { status: "failed", message: "kubectl returned non-JSON" };
    }

    const data = parsed as {
      status?: {
        active?: number;
        succeeded?: number;
        failed?: number;
      };
    };

    const jobStatus = data.status ?? {};

    if ((jobStatus.succeeded ?? 0) > 0) {
      return {
        status: "completed",
        exitCode: 0,
        ...(await this.podInfo(schedulerJobId, namespace)),
      };
    }
    if ((jobStatus.failed ?? 0) > 0) {
      const failure = await this.podFailure(schedulerJobId, namespace);
      const message = failure.reason ? `Job failed in K8s: ${failure.reason}` : "Job failed in K8s";
      return {
        status: "failed",
        message,
        ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
      };
    }
    if ((jobStatus.active ?? 0) > 0) {
      const runtimeFailure = await this.podRuntimeFailure(schedulerJobId, namespace);
      if (runtimeFailure.reason) {
        return { status: "failed", message: `K8s pod runtime failure: ${runtimeFailure.reason}` };
      }
      return { status: "running", ...(await this.podInfo(schedulerJobId, namespace)) };
    }
    // No active/succeeded/failed pods yet — still pending. Surface why it's
    // stuck (Unschedulable / ImagePullBackOff / …) when the pod reports it.
    return { status: "queued", ...(await this.podReason(schedulerJobId, namespace)) };
  }

  prepareResume(spec: JobSpec, schedulerJobId: string): void {
    const namespace =
      spec.sandbox?.identity.backend === "Kubernetes"
        ? spec.sandbox.identity.namespace
        : (spec.queueName ?? this.namespace);
    this.jobNamespaces.set(schedulerJobId, namespace);
  }

  releaseJob(schedulerJobId: string): void {
    this.jobNamespaces.delete(schedulerJobId);
  }

  private namespaceFor(schedulerJobId: string): string {
    return this.jobNamespaces.get(schedulerJobId) ?? this.namespace;
  }

  /** Best-effort "why is this pod still pending" for a queued job. A container
   *  stuck waiting (ImagePullBackOff, CrashLoopBackOff, ContainerCreating) is the
   *  most specific cause, so it wins over an unschedulable PodScheduled=False
   *  condition. Any failure (no pod, kubectl error, non-JSON) degrades to {} —
   *  status must not break over a missing reason. */
  private async podReason(schedulerJobId: string, namespace: string): Promise<{ reason?: string }> {
    try {
      const { exitCode, stdout } = await this.spawner.run([
        "kubectl",
        "get",
        "pods",
        "-n",
        namespace,
        "--selector",
        `job-name=${schedulerJobId}`,
        "-o",
        "json",
      ]);
      if (exitCode !== 0 || !stdout.trim()) return {};
      const data = JSON.parse(stdout) as {
        items?: Array<{
          status?: {
            conditions?: Array<{ type?: string; status?: string; reason?: string }>;
            containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>;
          };
        }>;
      };
      const podStatus = data.items?.[0]?.status;
      if (!podStatus) return {};
      const waiting = podStatus.containerStatuses?.find((c) => c.state?.waiting?.reason)?.state
        ?.waiting?.reason;
      if (waiting) return { reason: waiting };
      const scheduled = podStatus.conditions?.find(
        (c) => c.type === "PodScheduled" && c.status === "False",
      );
      return scheduled?.reason ? { reason: scheduled.reason } : {};
    } catch {
      return {};
    }
  }

  private async podRuntimeFailure(
    schedulerJobId: string,
    namespace: string,
  ): Promise<{ reason?: string }> {
    try {
      const { exitCode, stdout } = await this.spawner.run([
        "kubectl",
        "get",
        "pods",
        "-n",
        namespace,
        "--selector",
        `job-name=${schedulerJobId}`,
        "-o",
        "json",
      ]);
      if (exitCode !== 0 || !stdout.trim()) return {};
      const data = JSON.parse(stdout) as {
        items?: Array<{
          metadata?: { uid?: string };
          status?: {
            containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>;
          };
        }>;
      };
      const pod = data.items?.[0];
      const uid = pod?.metadata?.uid;
      if (!uid) return {};
      const waiting = pod.status?.containerStatuses?.find((c) => c.state?.waiting?.reason)?.state
        ?.waiting?.reason;
      if (waiting !== "ContainerCreating") return {};

      const event = await this.podSandboxEvent(uid, namespace);
      return event ? { reason: event } : {};
    } catch {
      return {};
    }
  }

  private async podSandboxEvent(podUid: string, namespace: string): Promise<string | undefined> {
    const { exitCode, stdout } = await this.spawner.run([
      "kubectl",
      "get",
      "events",
      "-n",
      namespace,
      "--field-selector",
      `involvedObject.uid=${podUid}`,
      "-o",
      "json",
    ]);
    if (exitCode !== 0 || !stdout.trim()) return undefined;
    const data = JSON.parse(stdout) as {
      items?: Array<{ reason?: string; message?: string }>;
    };
    const event = data.items?.find(
      (item) =>
        item.reason === "FailedCreatePodSandBox" || item.message?.includes("CreatePodSandbox"),
    );
    if (!event) return undefined;
    return [event.reason, event.message].filter((part): part is string => !!part).join(": ");
  }

  /** Best-effort failure detail for a failed job — the container's terminated
   *  exit code + reason (`OOMKilled`, `Error`, …), which live on the Pod, not
   *  the Job. Degrades to {} on any failure so status() still reports `failed`. */
  private async podFailure(
    schedulerJobId: string,
    namespace: string,
  ): Promise<{ exitCode?: number; reason?: string }> {
    try {
      const { exitCode, stdout } = await this.spawner.run([
        "kubectl",
        "get",
        "pods",
        "-n",
        namespace,
        "--selector",
        `job-name=${schedulerJobId}`,
        "-o",
        "json",
      ]);
      if (exitCode !== 0 || !stdout.trim()) return {};
      const data = JSON.parse(stdout) as {
        items?: Array<{
          status?: {
            containerStatuses?: Array<{
              state?: { terminated?: { exitCode?: number; reason?: string } };
            }>;
          };
        }>;
      };
      const terminated = data.items?.[0]?.status?.containerStatuses?.find(
        (c) => c.state?.terminated,
      )?.state?.terminated;
      if (!terminated) return {};
      return {
        ...(terminated.exitCode !== undefined ? { exitCode: terminated.exitCode } : {}),
        ...(terminated.reason ? { reason: terminated.reason } : {}),
      };
    } catch {
      return {};
    }
  }

  /** Best-effort lookup of the job's pod placement — the node it landed on and
   *  its start time — which live on the Pod (`spec.nodeName` / `status.startTime`,
   *  RFC3339), not the Job. One combined jsonpath call, tab-separated. Any
   *  failure (no pod yet, kubectl error) degrades to {} — status must not break
   *  over missing placement. */
  private async podInfo(
    schedulerJobId: string,
    namespace: string,
  ): Promise<{ node?: string; startedAt?: string }> {
    try {
      const { exitCode, stdout } = await this.spawner.run([
        "kubectl",
        "get",
        "pods",
        "-n",
        namespace,
        "--selector",
        `job-name=${schedulerJobId}`,
        "-o",
        'jsonpath={.items[0].spec.nodeName}{"\\t"}{.items[0].status.startTime}',
      ]);
      if (exitCode !== 0) return {};
      const [rawNode, rawStart] = stdout.split("\t");
      const node = rawNode?.trim() || undefined;
      const start = rawStart?.trim();
      const startedAt = start && !Number.isNaN(Date.parse(start)) ? start : undefined;
      return { ...(node ? { node } : {}), ...(startedAt ? { startedAt } : {}) };
    } catch {
      return {};
    }
  }

  private requireSandboxSeccompProfile(): NonNullable<K8sAdapterDeps["sandboxSeccompProfile"]> {
    if (!this.sandboxSeccompProfile) {
      throw new Error("Kubernetes Sandbox requires a verified Localhost seccomp profile");
    }
    return this.sandboxSeccompProfile;
  }
}
