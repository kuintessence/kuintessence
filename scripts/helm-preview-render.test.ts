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

interface Resource {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: {
    replicas?: number;
    template?: { metadata?: { annotations?: Record<string, string> }; spec: Pod };
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

function render(overrides: string[] = []) {
  const settings = [
    "preview.host=pr-14.preview.example.test",
    ...images.flatMap(([key, component]) => [
      `${key}.image.repository=ghcr.io/example/kq-dev-${component}`,
      `${key}.image.tag=sha-${sha}`,
    ]),
    ...overrides,
  ];
  return run([
    "template",
    "pr-14",
    join(fixture, "kq-preview"),
    "--namespace",
    "kq-preview-pr-14",
    ...settings.flatMap((setting) => ["--set-string", `kq-platform.${setting}`]),
  ]);
}

function resources(overrides: string[] = []) {
  const result = render(overrides);
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

function resource(items: Resource[], kind: string, suffix: string): Resource {
  const found = items.find((item) => {
    return item.kind === kind && item.metadata.name === `pr-14-${suffix}`;
  });
  if (!found) throw new Error(`Missing ${kind} ${suffix}`);
  return found;
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
      item.metadata.name.startsWith("pr-14-rustfs-bootstrap-"),
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
          name: "kq-preview-secrets",
          key: "DATABASE_URL",
        });
      }
    }
    expect(output).not.toContain("postgres://");
    expect(output).not.toMatch(/hostPath:|hostNetwork:|docker\.sock|privileged: true/);
    expect(output).toContain("SPACK_RECIPE_STORE_DIR");
    expect(output).toContain("SPACK_MATERIAL_STORE_DIR");
    expect(output).toContain('NETDRIVE_PUBLIC_URL: "https://pr-14.preview.example.test"');
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
        host: "pr-14.preview.example.test",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: "pr-14-gateway", port: { number: 8080 } } },
            },
          ],
        },
      },
    ]);
    expect(ingress.spec?.tls).toEqual([{ hosts: ["pr-14.preview.example.test"] }]);
    expect(resource(items, "NetworkPolicy", "preview-internal")).toBeDefined();
    expect(resource(items, "NetworkPolicy", "preview-entry")).toBeDefined();
  });

  test("renders release-aware Web upstreams and secret-free gateway configuration", () => {
    const { items } = resources();
    const web = resource(items, "ConfigMap", "web-nginx").data?.["default.conf"] ?? "";
    expect(web).toContain("proxy_pass http://pr-14-server:3000;");
    expect(web).toContain("proxy_pass http://pr-14-registry:3100;");
    expect(web).not.toContain("http://server:3000");
    expect(web).not.toContain("http://registry:3100");
    const gateway =
      resource(items, "ConfigMap", "preview-gateway").data?.["default.conf.template"] ?? "";
    expect(gateway).toContain(`"\${PREVIEW_COOKIE}" 1;`);
    expect(gateway).toContain("proxy_pass http://pr-14-web:80;");
    expect(gateway).toContain("proxy_pass http://pr-14-rustfs:9000;");
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
      valueFrom: { secretKeyRef: { name: "kq-preview-secrets", key: "PREVIEW_COOKIE" } },
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
      secretName: "kq-preview-secrets",
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
      value: "https://pr-14-server:3001",
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
      "pr-14",
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
      persistentVolumeClaim: { claimName: "pr-14-agent" },
    });
  });

  test.each([
    ["preview.host=", "preview.host must be"],
    ["secrets.existingSecret=", "existingSecret"],
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
