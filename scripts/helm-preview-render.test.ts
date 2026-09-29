import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const helm = Bun.which("helm");
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const release = "kq-pr-17";
const instanceLabel = "app.kubernetes.io/instance";
const managedByLabel = "app.kubernetes.io/managed-by";
const repository = "example/project";
const images = [
  ["server", "server"],
  ["registry", "registry"],
  ["web", "web"],
  ["migration", "db-migrate"],
  ["scheduler", "scheduler"],
  ["seed", "seed"],
] as const;
let fixture = "";

interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string } };
  }[];
  securityContext?: { privileged?: boolean; runAsUser?: number };
  volumeMounts?: { mountPath: string; subPath?: string; name: string; readOnly?: boolean }[];
}

interface Pod {
  nodeSelector?: Record<string, string>;
  imagePullSecrets?: { name: string }[];
  containers: Container[];
  initContainers?: Container[];
  volumes?: {
    name: string;
    secret?: {
      secretName: string;
      defaultMode?: number;
      items: { key: string; path: string }[];
    };
    persistentVolumeClaim?: { claimName: string };
  }[];
}

type Labels = Record<string, string>;

interface LabelSelector {
  matchLabels: Labels;
}

interface Metadata {
  name: string;
  labels?: Labels;
  annotations?: Labels;
}

interface Resource {
  kind: string;
  metadata: Metadata;
  data?: Record<string, string>;
  rules?: { resources: string[]; verbs: string[]; resourceNames?: string[] }[];
  spec?: {
    replicas?: number;
    selector?: Labels | LabelSelector;
    template?: { metadata?: { annotations?: Labels; labels?: Labels }; spec: Pod };
    volumeClaimTemplates?: { metadata: Metadata }[];
    scaleTargetRef?: { kind: string; name: string };
    podSelector?: LabelSelector;
    policyTypes?: string[];
    ingress?: {
      from: { podSelector?: LabelSelector; namespaceSelector?: LabelSelector }[];
      ports?: { protocol: string; port: number }[];
    }[];
    rules?: { host: string; http: { paths: unknown[] } }[];
    tls?: { hosts: string[]; secretName?: string }[];
    ingressClassName?: string;
  };
}

function run(args: string[]) {
  if (!helm) throw new Error("Helm render tests require Helm in Actions");
  const result = Bun.spawnSync({
    cmd: [helm, ...args],
    cwd: fixture,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function render(
  overrides: string[] = [],
  name = release,
  namespace = "preview",
  extraArgs: string[] = [],
) {
  const settings = [
    `preview.host=${name}.preview.example.test`,
    `preview.repository=${repository}`,
    `secrets.existingSecret=${name}-secrets`,
    ...images.flatMap(([key, component]) => [
      `${key}.image.repository=ghcr.io/example/kq-dev-${component}`,
      `${key}.image.tag=sha-${sha}`,
    ]),
    ...overrides,
  ];
  return run([
    "template",
    name,
    join(fixture, "kq-preview"),
    "--namespace",
    namespace,
    ...settings.flatMap((setting) => ["--set-string", `kq-platform.${setting}`]),
    ...extraArgs,
  ]);
}

function resources(overrides: string[] = [], name = release) {
  const result = render(overrides, name);
  expect(result.code, result.stderr).toBe(0);
  return { items: parseResources(result.stdout), output: result.stdout };
}

function parseResources(output: string): Resource[] {
  return parseAllDocuments(output)
    .map((document) => {
      expect(document.errors).toEqual([]);
      return document.toJS() as Resource | null;
    })
    .filter((item): item is Resource => item !== null);
}

function resource(items: Resource[], kind: string, suffix: string, name = release): Resource {
  const found = items.find((item) => {
    return item.kind === kind && item.metadata.name === `${name}-${suffix}`;
  });
  if (!found) throw new Error(`Missing ${kind} ${suffix}`);
  return found;
}

function selectorLabels(item: Resource): Labels {
  const selector = item.spec?.selector;
  if (!selector) throw new Error(`Missing selector for ${item.kind}`);
  if (typeof selector.matchLabels === "object") return selector.matchLabels;
  return selector as Labels;
}

function selects(selector: Labels, labels: Labels = {}): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function pod(items: Resource[], kind: string, suffix: string): Pod {
  const spec = resource(items, kind, suffix).spec?.template?.spec;
  if (!spec) throw new Error(`Missing Pod ${suffix}`);
  return spec;
}

describe.skipIf(!helm)("Helm preview render (Actions only)", () => {
  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), "kq-helm-preview-"));
    await cp(join(root, "deploy/helm/kq-platform"), join(fixture, "kq-platform"), {
      recursive: true,
    });
    await cp(join(root, "deploy/helm/kq-preview"), join(fixture, "kq-preview"), {
      recursive: true,
    });
    const result = run(["dependency", "build", join(fixture, "kq-preview"), "--skip-refresh"]);
    expect(result.code, result.stderr).toBe(0);
  });

  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  test("two releases in preview have disjoint resources, selectors and Pod ownership", () => {
    const releases = [release, "kq-pr-18"];
    const stacks = releases.map((name) => resources([], name).items);
    const identities = new Set<string>();
    for (const [index, items] of stacks.entries()) {
      const name = releases[index];
      const otherPods = stacks
        .filter((_, otherIndex) => otherIndex !== index)
        .flat()
        .flatMap((item) => (item.spec?.template ? [item.spec.template] : []));
      const ownPods = items.flatMap((item) => (item.spec?.template ? [item.spec.template] : []));
      expect(ownPods).toHaveLength(11);
      for (const item of items) {
        expect(item.metadata.name.startsWith(`${name}-`)).toBe(true);
        const identity = `${item.kind}/${item.metadata.name}`;
        expect(identities.has(identity)).toBe(false);
        identities.add(identity);
        expect(item.metadata.labels?.[instanceLabel]).toBe(name);
        expect(item.metadata.labels?.[managedByLabel]).toBe("Helm");
        if (item.spec?.template) {
          expect(item.spec.template.metadata?.labels?.[instanceLabel]).toBe(name);
          expect(item.spec.template.metadata?.labels?.[managedByLabel]).toBe("Helm");
        }
        if (["Deployment", "StatefulSet", "Service"].includes(item.kind)) {
          const selector = selectorLabels(item);
          expect(selector[instanceLabel]).toBe(name);
          expect(ownPods.filter((spec) => selects(selector, spec.metadata?.labels))).toHaveLength(1);
          expect(otherPods.some((spec) => selects(selector, spec.metadata?.labels))).toBe(false);
          if (item.spec?.template) {
            expect(selects(selector, item.spec.template.metadata?.labels)).toBe(true);
          }
        }
        // Jobs retain Kubernetes-generated selectors; release labels belong on their Pods.
        if (item.kind === "Job") expect(item.spec?.selector).toBeUndefined();
      }
    }
  });

  test("preview ingress policies isolate releases and admit only Traefik to the gateway", () => {
    for (const name of [release, "kq-pr-18"]) {
      const enableGenericPolicy = ["--set", "kq-platform.networkPolicy.enabled=true"];
      const result = render([], name, "preview", enableGenericPolicy);
      expect(result.code, result.stderr).toBe(0);
      const items = parseResources(result.stdout);
      expect(items.filter((item) => item.kind === "NetworkPolicy")).toHaveLength(2);
      const labels = { "app.kubernetes.io/name": "kq-platform", [instanceLabel]: name };
      const internal = resource(items, "NetworkPolicy", "preview-internal", name);
      expect(internal.spec).toEqual({
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: labels } }] }],
      });
      const entry = resource(items, "NetworkPolicy", "preview-entry", name);
      expect(entry.spec).toEqual({
        podSelector: {
          matchLabels: { ...labels, "app.kubernetes.io/component": "gateway" },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      });
    }
  });

  test("all five preview PVCs carry exact cleanup ownership without cross-release names", () => {
    const names = new Set<string>();
    for (const name of [release, "kq-pr-18"]) {
      const { items } = resources([], name);
      const claims: Metadata[] = [];
      for (const item of items) {
        if (item.kind === "PersistentVolumeClaim") claims.push(item.metadata);
        if (item.kind !== "StatefulSet") continue;
        expect(item.spec?.volumeClaimTemplates).toHaveLength(1);
        for (const claim of item.spec?.volumeClaimTemplates ?? []) {
          claims.push({
            ...claim.metadata,
            name: `${claim.metadata.name}-${item.metadata.name}-0`,
          });
        }
      }
      expect(claims.map((claim) => claim.name).sort()).toEqual(
        [
          `${name}-agent`,
          `${name}-registry-blobs`,
          `data-${name}-postgres-0`,
          `data-${name}-redis-0`,
          `data-${name}-rustfs-0`,
        ].sort(),
      );
      for (const claim of claims) {
        expect(claim.labels).toMatchObject({
          [instanceLabel]: name,
          [managedByLabel]: "Helm",
          "kuintessence.com/preview-pr": name.slice("kq-pr-".length),
        });
        expect(claim.annotations?.["kuintessence.com/repository"]).toBe(repository);
        expect(names.has(claim.name)).toBe(false);
        names.add(claim.name);
      }
    }
  });

  test("preview wait RBAC can read only this release's dependency Jobs", () => {
    for (const name of [release, "kq-pr-18"]) {
      const { items } = resources([], name);
      const jobs = items.filter((item) => item.kind === "Job").map((item) => item.metadata.name);
      const role = resource(items, "Role", "workload-wait", name);
      expect(role.rules).toHaveLength(1);
      expect(role.rules?.[0]?.resources).toEqual(["jobs"]);
      expect(role.rules?.[0]?.verbs).toEqual(["get", "list", "watch"]);
      expect(role.rules?.[0]?.resourceNames?.toSorted()).toEqual(jobs.toSorted());
    }
  });

  test.each(["default", "kq-preview-pr-17"])("rejects preview namespace %s", (namespace) => {
    const result = render([], release, namespace);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Release.Namespace=preview");
  });

  test.each(["pr-17", "kq-pr-0", "kq-pr-017"])("rejects preview release %s", (name) => {
    const result = render([], name);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Release.Name=kq-pr-<positive PR number>");
  });

  test("non-preview keeps legacy immutable selectors and claim templates in any namespace", () => {
    const result = run([
      "template",
      "user",
      join(fixture, "kq-platform"),
      "--namespace",
      "user-production",
      "--set-string",
      "secrets.existingSecret=user-secrets",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const items = parseResources(result.stdout);
    for (const [kind, component] of [
      ["Deployment", "server"],
      ["Deployment", "registry"],
      ["StatefulSet", "postgres"],
      ["StatefulSet", "redis"],
      ["StatefulSet", "rustfs"],
    ]) {
      const workload = resource(items, kind, component, "user");
      const labels = {
        "app.kubernetes.io/name": "kq-platform",
        "app.kubernetes.io/component": component,
      };
      expect(selectorLabels(workload)).toEqual(labels);
      expect(selects(labels, workload.spec?.template?.metadata?.labels)).toBe(true);
      expect(selectorLabels(resource(items, "Service", component, "user"))).toEqual(labels);
      if (kind === "StatefulSet") {
        expect(workload.spec?.volumeClaimTemplates?.map((claim) => claim.metadata)).toEqual([
          { name: "data" },
        ]);
      }
    }
    expect(items.some((item) => item.kind === "NetworkPolicy")).toBe(false);
  });

  test("optional PDBs select the matching release Pods and HPA targets its own Deployment", () => {
    for (const name of ["user-one", "user-two"]) {
      const result = run([
        "template",
        name,
        join(fixture, "kq-platform"),
        "--set-string",
        `secrets.existingSecret=${name}-secrets`,
        "--set",
        "server.replicas=2,registry.replicas=2,registry.recipes.enabled=false",
        "--set",
        "server.podDisruptionBudget.enabled=true,registry.podDisruptionBudget.enabled=true",
        "--set",
        "server.autoscaling.enabled=true",
      ]);
      expect(result.code, result.stderr).toBe(0);
      const items = parseResources(result.stdout);
      for (const component of ["server", "registry"]) {
        const pdb = resource(items, "PodDisruptionBudget", component, name);
        const selector = selectorLabels(pdb);
        expect(selector[instanceLabel]).toBe(name);
        const deployment = resource(items, "Deployment", component, name);
        expect(selects(selector, deployment.spec?.template?.metadata?.labels)).toBe(true);
        expect(selects(selector, { ...selector, [instanceLabel]: `${name}-other` })).toBe(false);
      }
      const hpa = resource(items, "HorizontalPodAutoscaler", "server", name);
      expect(hpa.metadata.labels?.[instanceLabel]).toBe(name);
      expect(hpa.spec?.scaleTargetRef).toMatchObject({
        kind: "Deployment",
        name: `${name}-server`,
      });
    }
  });

  test("renders the full stack with only Secret references and single-node placement", () => {
    const { items, output } = resources();
    for (const name of ["server", "registry", "web", "gateway", "scheduler"]) {
      expect(resource(items, "Deployment", name).spec?.replicas).toBe(1);
    }
    for (const name of ["postgres", "redis", "rustfs"]) {
      expect(resource(items, "StatefulSet", name)).toBeDefined();
    }
    expect(resource(items, "Job", "db-migrate-r1")).toBeDefined();
    expect(resource(items, "Job", "seed-r1")).toBeDefined();
    const bootstrap = items.find((item) =>
      item.metadata.name.startsWith(`${release}-rustfs-bootstrap-`),
    );
    expect(bootstrap).toBeDefined();
    expect(resource(items, "PersistentVolumeClaim", "agent")).toBeDefined();
    expect(resource(items, "PersistentVolumeClaim", "registry-blobs")).toBeDefined();
    expect(items.filter((item) => item.kind === "Secret")).toEqual([]);
    for (const item of items) {
      if (!item.spec?.template) continue;
      expect(item.spec.template.spec.nodeSelector).toEqual({
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": "amd64",
      });
      expect(item.spec.template.spec.imagePullSecrets).toBeUndefined();
      for (const container of item.spec.template.spec.containers) {
        const database = container.env?.find((env) => env.name === "DATABASE_URL");
        if (!database) continue;
        expect(database.value).toBeUndefined();
        expect(database.valueFrom?.secretKeyRef).toEqual({
          name: `${release}-secrets`,
          key: "DATABASE_URL",
        });
      }
    }
    expect(output).not.toContain("postgres://");
    expect(output).not.toMatch(/hostPath:|hostNetwork:|docker\.sock|privileged: true/);
    expect(output).toContain("SPACK_RECIPE_STORE_DIR");
    expect(output).toContain("SPACK_MATERIAL_STORE_DIR");
    expect(output).toContain(`NETDRIVE_PUBLIC_URL: "https://${release}.preview.example.test"`);
    for (const [, component] of images) {
      expect(output).toContain(`ghcr.io/example/kq-dev-${component}:sha-${sha}`);
    }
  });

  test("user chart keeps production authentication and optional minimal seed", () => {
    const result = run([
      "template",
      "user",
      join(fixture, "kq-platform"),
      "--set",
      "seed.enabled=true",
      "--set-string",
      "secrets.existingSecret=user-secrets",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('NODE_ENV: "production"');
    expect(result.stdout).toContain("name: SEED_MODE");
    expect(result.stdout).toContain('value: "minimal"');
    expect(result.stdout).not.toContain("name: user-gateway");
    expect(result.stdout).not.toContain("name: user-scheduler");
    expect(result.stdout).not.toContain('NODE_ENV: "development"');
    const insecure = run([
      "template",
      "user",
      join(fixture, "kq-platform"),
      "--set-string",
      "secrets.existingSecret=user-secrets",
      "--set-string",
      "server.env.NODE_ENV=development",
    ]);
    expect(insecure.code).not.toBe(0);
    expect(insecure.stderr).toContain("non-production Server requires preview.enabled");
  });

  test("uses six immutable image references with optional persistent pull credentials", () => {
    const { items } = resources([
      ...images.map(([key]) => `${key}.image.digest=${digest}`),
      "global.imagePullSecrets[0].name=kq-preview-ghcr",
    ]);
    const targets = [
      ["Deployment", "server", "server"],
      ["Deployment", "registry", "registry"],
      ["Deployment", "web", "web"],
      ["Job", "db-migrate-r1", "db-migrate"],
      ["Deployment", "scheduler", "scheduler"],
      ["Job", "seed-r1", "seed"],
    ] as const;
    for (const [kind, suffix, component] of targets) {
      const spec = pod(items, kind, suffix);
      expect(spec.containers[0]?.image).toBe(`ghcr.io/example/kq-dev-${component}@${digest}`);
      expect(spec.imagePullSecrets).toEqual([{ name: "kq-preview-ghcr" }]);
    }
  });

  test("exposes only the gateway with complete TLS hosts and no certificate Secret", () => {
    const { items } = resources();
    const ingress = resource(items, "Ingress", "ingress");
    expect(ingress.spec?.ingressClassName).toBe("traefik");
    expect(ingress.spec?.rules).toEqual([
      {
        host: `${release}.preview.example.test`,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: `${release}-gateway`, port: { number: 8080 } } },
            },
          ],
        },
      },
    ]);
    expect(ingress.spec?.tls).toEqual([{ hosts: [`${release}.preview.example.test`] }]);
    expect(resource(items, "NetworkPolicy", "preview-internal")).toBeDefined();
    expect(resource(items, "NetworkPolicy", "preview-entry")).toBeDefined();
  });

  test("renders release-aware Web upstreams and secret-free gateway configuration", () => {
    const { items } = resources();
    const web = resource(items, "ConfigMap", "web-nginx").data?.["default.conf"] ?? "";
    expect(web).toContain(`proxy_pass http://${release}-server:3000;`);
    expect(web).toContain(`proxy_pass http://${release}-registry:3100;`);
    expect(web).not.toContain("http://server:3000");
    expect(web).not.toContain("http://registry:3100");
    const gateway =
      resource(items, "ConfigMap", "preview-gateway").data?.["default.conf.template"] ?? "";
    expect(gateway).toContain(`"\${PREVIEW_COOKIE}" 1;`);
    expect(gateway).toContain(`proxy_pass http://${release}-web:80;`);
    expect(gateway).toContain(`proxy_pass http://${release}-rustfs:9000;`);
    expect(gateway).toContain("proxy_set_header Host $http_host;");
    expect(gateway).not.toContain("9001");
    expect(gateway).toContain("map $args $preview_s3_signature_present");
    for (const bucket of [
      "kuintessence",
      "kuintessence-data-market-staging",
      "kuintessence-data-market-immutable",
    ]) {
      expect(gateway).toContain(`location = /${bucket} {\n        return 404;`);
      expect(gateway).toContain(`location = /${bucket}/ {\n        return 404;`);
      const objectStart = gateway.indexOf(`location ^~ /${bucket}/ {`);
      const objectEnd = gateway.indexOf("\n    }", objectStart);
      const objectRoute = gateway.slice(objectStart, objectEnd);
      expect(objectStart).toBeGreaterThanOrEqual(0);
      expect(objectEnd).toBeGreaterThan(objectStart);
      expect(objectRoute).toContain("if ($preview_s3_signature_present = 0)");
      expect(objectRoute).toContain("if ($preview_s3_method_allowed = 0)");
      expect(objectRoute).toContain('proxy_set_header Authorization "";');
      expect(objectRoute).not.toContain("$preview_allowed");
    }
    const spec = pod(items, "Deployment", "gateway");
    expect(spec.containers[0]?.env).toContainEqual({
      name: "PREVIEW_COOKIE",
      valueFrom: { secretKeyRef: { name: `${release}-secrets`, key: "PREVIEW_COOKIE" } },
    });
    expect(spec.volumes?.find((volume) => volume.name === "preview-auth")?.secret?.items).toEqual([
      { key: "PREVIEW_HTPASSWD", path: "htpasswd" },
    ]);
  });

  test("rotating the non-secret credentials revision changes the gateway Pod template", () => {
    const firstRevision = "c".repeat(64);
    const nextRevision = "d".repeat(64);
    const first = resources([`preview.credentialsRevision=${firstRevision}`]);
    const next = resources([`preview.credentialsRevision=${nextRevision}`]);
    const firstTemplate = resource(first.items, "Deployment", "gateway").spec?.template;
    const nextTemplate = resource(next.items, "Deployment", "gateway").spec?.template;
    const key = "kq.io/preview-credentials-revision";
    expect(firstTemplate?.metadata?.annotations?.[key]).toBe(firstRevision);
    expect(nextTemplate?.metadata?.annotations?.[key]).toBe(nextRevision);
    expect(firstTemplate?.spec).toEqual(nextTemplate?.spec);
    expect(resource(first.items, "ConfigMap", "preview-gateway").data).toEqual(
      resource(next.items, "ConfigMap", "preview-gateway").data,
    );
  });

  test("native mTLS keeps Server private keys off Agent", () => {
    const { items, output } = resources();
    expect(output).toContain('MTLS_MODE: "direct"');
    const server = pod(items, "Deployment", "server");
    const tls = server.volumes?.find((volume) => volume.name === "grpc-tls")?.secret;
    expect(tls).toEqual({
      secretName: `${release}-secrets`,
      defaultMode: 0o400,
      items: [
        { key: "SERVER_CA_CERT", path: "ca/ca.crt" },
        { key: "SERVER_CA_KEY", path: "ca/ca.key" },
        { key: "SERVER_TLS_CERT", path: "tls/server.crt" },
        { key: "SERVER_TLS_KEY", path: "tls/server.key" },
      ],
    });
    expect(server.containers[0]?.volumeMounts).toContainEqual({
      name: "grpc-tls",
      mountPath: "/etc/kuintessence",
      readOnly: true,
    });
    for (const [name, value] of [
      ["SERVER_CA_DIR", "/etc/kuintessence/ca"],
      ["SERVER_GRPC_TLS_CERT_FILE", "/etc/kuintessence/tls/server.crt"],
      ["SERVER_GRPC_TLS_KEY_FILE", "/etc/kuintessence/tls/server.key"],
    ]) {
      expect(server.containers[0]?.env).toContainEqual({ name, value });
    }
    const scheduler = pod(items, "Deployment", "scheduler");
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "SERVER_GRPC_URL",
      value: `https://${release}-server:3001`,
    });
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "AGENT_MTLS_REQUIRED",
      value: "true",
    });
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "AGENT_SPACK_ENABLED",
      value: "false",
    });
    expect(scheduler.volumes?.some((volume) => volume.secret !== undefined)).toBe(false);
    expect(output).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  test("user scheduler requires an existing registered bundle, not development login", () => {
    const args = [
      "template",
      release,
      join(fixture, "kq-platform"),
      "--set",
      "scheduler.enabled=true",
      "--set-string",
      "secrets.existingSecret=user-secrets",
      "--set-string",
      "server.env.MTLS_MODE=direct",
    ];
    const missing = run(args);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("scheduler.registration.existingSecret");
    const configured = run([
      ...args,
      "--set-string",
      "scheduler.registration.existingSecret=registered-agent",
      "--set-string",
      "scheduler.registration.credentialsRevision=2",
      "--set-string",
      "server.grpcTls.existingSecret=server-pki",
    ]);
    expect(configured.code, configured.stderr).toBe(0);
    const items = parseResources(configured.stdout);
    const scheduler = pod(items, "Deployment", "scheduler");
    expect(scheduler.initContainers?.map((container) => container.name)).toEqual(["prepare-agent"]);
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "KQ_AGENT_REGISTRATION_ENABLED",
      value: "0",
    });
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "NODE_ENV",
      value: "production",
    });
    expect(scheduler.containers[0]?.env).toContainEqual({
      name: "KQ_AGENT_ENV_FILE",
      value: "/etc/kuintessence/agent-config/agent.env",
    });
    expect(scheduler.containers[0]?.volumeMounts).toContainEqual({
      name: "agent-registration",
      mountPath: "/etc/kuintessence/agent-certs",
      readOnly: true,
    });
    const registration = scheduler.volumes?.find((volume) => {
      return volume.name === "agent-registration";
    });
    expect(registration?.secret).toEqual({
      secretName: "registered-agent",
      defaultMode: 0o400,
      items: [
        { key: "client.crt", path: "client.crt" },
        { key: "client.key", path: "client.key" },
        { key: "ca.crt", path: "ca.crt" },
      ],
    });
    const server = pod(items, "Deployment", "server");
    const tls = server.volumes?.find((volume) => volume.name === "grpc-tls")?.secret;
    expect(tls?.secretName).toBe("server-pki");
    expect(configured.stdout).not.toContain("name: KQ_AGENT_REGISTRATION_ROLE");
  });

  test("gates Slurm on seed and preserves the image entrypoint and state", () => {
    const { items } = resources();
    const seed = pod(items, "Job", "seed-r1");
    expect(seed.initContainers?.[0]?.name).toBe("wait-db-migration");
    expect(seed.containers[0]?.command).toBeUndefined();
    expect(seed.containers[0]?.env).toContainEqual({ name: "SEED_MODE", value: "demo" });
    const scheduler = pod(items, "Deployment", "scheduler");
    const server = pod(items, "Deployment", "server");
    expect(server.initContainers?.map((container) => container.name)).toContain("wait-seed");
    expect(scheduler.initContainers?.[0]?.name).toBe("wait-seed");
    expect(scheduler.containers).toHaveLength(1);
    expect(scheduler.containers[0]?.command).toBeUndefined();
    expect(scheduler.containers[0]?.securityContext?.privileged).toBe(false);
    expect(scheduler.volumes).toContainEqual({
      name: "agent-state",
      persistentVolumeClaim: { claimName: `${release}-agent` },
    });
  });

  test.each([
    ["preview.host=", "preview.host must be"],
    ["preview.repository=", "preview.repository must be"],
    ["preview.repository=owner/repo/extra", "preview.repository must be"],
    ["secrets.existingSecret=", "existingSecret"],
    ["secrets.existingSecret=kq-preview-secrets", "existingSecret=<release>-secrets"],
    ["secrets.existingSecret=kq-pr-18-secrets", "existingSecret=<release>-secrets"],
    ["preview.credentialsRevision=not-a-hash", "preview.credentialsRevision must be"],
    ["server.env.MTLS_MODE=off", "requires server.env.MTLS_MODE=direct"],
    ["postgres.password=not-a-real-password", "preview credentials"],
    ["server.env.NODE_ENV=production", "preview scheduler registration"],
    ["ingress.className=nginx", "ingress.className=traefik"],
    ["ingress.tls[0].secretName=kube-system-cert", "preview TLS"],
    ["netdrive.publicUrl=https://different.example.test", "preview netdrive.publicUrl"],
    ["global.nodeSelector.kubernetes\\.io/arch=arm64", "linux/amd64"],
    ["seed.mode=everything", "seed.mode must be minimal or demo"],
    ["server.image.digest=invalid", "image.digest must be a sha256 digest"],
  ])("rejects unsafe configuration %s", (setting, message) => {
    const result = render([setting]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
