import { describe, expect, test } from "bun:test";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const chart = "deploy/helm/kq-platform";
const helm = Bun.which("helm");
const read = (path: string) => Bun.file(resolve(root, path)).text();

interface ComposeService {
  environment?: Record<string, string>;
  volumes?: string[];
}

interface Compose {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

interface RegistryValues {
  registry: {
    replicas: number;
    persistence: { enabled: boolean; mountPath: string };
    recipes?: { enabled: boolean; bootstrapManifest: string; materialBootstrapManifest: string };
  };
}

interface Resource {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: {
    replicas?: number;
    strategy?: { type: string; rollingUpdate?: null };
    template?: {
      spec: {
        containers: {
          name: string;
          env: { name: string; value?: string }[];
          volumeMounts?: { name: string; mountPath: string; subPath?: string }[];
        }[];
        volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
      };
    };
  };
}

async function compose(path: string): Promise<Compose> {
  return parse(await read(`deploy/compose/${path}`), {
    merge: true,
    logLevel: "silent",
  }) as Compose;
}

function render(settings: string[] = []) {
  if (!helm) throw new Error("Helm is unavailable; render tests must be skipped");
  const result = Bun.spawnSync({
    cmd: [
      helm,
      "template",
      "kq",
      chart,
      "-f",
      `${chart}/values.testing.yaml`,
      ...settings.flatMap((setting) => ["--set", setting]),
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function resources(settings: string[] = []): Resource[] {
  const result = render(settings);
  expect(result.code, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout).map((doc) => {
    expect(doc.errors).toEqual([]);
    return doc.toJS() as Resource;
  });
}

function registry(items: Resource[]) {
  const deployment = items.find(
    (item) => item.kind === "Deployment" && item.metadata.name === "kq-registry",
  );
  expect(deployment).toBeDefined();
  const pod = deployment?.spec?.template?.spec;
  const container = pod?.containers.find((item) => item.name === "registry");
  expect(container).toBeDefined();
  return {
    deployment,
    pod,
    container,
    env: Object.fromEntries(container?.env.map((item) => [item.name, item.value]) ?? []),
  };
}

describe("recipe container storage (offline)", () => {
  for (const [file, serviceName, volume, mount, blob] of [
    [
      "docker-compose.yml",
      "registry",
      "registry-data",
      "/var/lib/kuintessence/registry",
      "/var/lib/kuintessence/registry/blobs",
    ],
    [
      "docker-compose.preview.yml",
      "registry",
      "registry-data",
      "/var/lib/kuintessence/registry",
      "/var/lib/kuintessence/registry",
    ],
    [
      "docker-compose.schedulers.yml",
      "registry",
      "scheduler-registry-data",
      "/var/lib/kuintessence/registry",
      "/var/lib/kuintessence/registry/blobs",
    ],
    ["docker-compose.aio.yml", "kq", "kq-aio-data", "/data", undefined],
  ] as const) {
    test(`${file} keeps recipes on its existing data volume without moving blobs`, async () => {
      const config = await compose(file);
      const service = config.services[serviceName];
      const path = service?.environment?.SPACK_RECIPE_STORE_DIR;
      expect(path).toBe(
        serviceName === "kq" ? "/data/registry/recipes" : "/var/lib/kuintessence/registry/recipes",
      );
      expect(posix.isAbsolute(path ?? "")).toBe(true);
      expect(service?.volumes).toContain(`${volume}:${mount}`);
      expect(config.volumes).toHaveProperty(volume);
      expect(service?.environment?.SPACK_RECIPE_BOOTSTRAP_MANIFEST).toBe(
        `\${SPACK_RECIPE_BOOTSTRAP_MANIFEST:-}`,
      );
      if (blob) expect(service?.environment?.BLOB_STORE_DIR).toBe(blob);
    });
  }

  test("watch override does not replace the registry data mount or recipe environment", async () => {
    const base = (await compose("docker-compose.yml")).services.registry;
    const watch = (await compose("docker-compose.watch.yml")).services.registry;
    expect(base?.environment?.SPACK_RECIPE_STORE_DIR).toBe(
      "/var/lib/kuintessence/registry/recipes",
    );
    expect(watch?.environment?.SPACK_RECIPE_STORE_DIR).toBeUndefined();
    expect(watch?.volumes?.some((volume) => volume.includes(":/var/lib/kuintessence"))).toBe(false);
  });

  for (const file of [
    "packages/registry/Dockerfile",
    "deploy/dev/Dockerfile",
    "deploy/aio/Dockerfile",
  ]) {
    test(`${file} installs Git in the final runtime and disables ambient Git config`, async () => {
      const runtime = (await read(file)).split(/^FROM /m).at(-1) ?? "";
      const instructions = runtime.replace(/\\\r?\n\s*/g, " ");
      expect(instructions).toMatch(/^RUN apk add --no-cache [^\n]*\bgit\b/m);
      expect(instructions).toMatch(/^ENV [^\n]*\bGIT_CONFIG_GLOBAL=\/dev\/null(?:\s|$)/m);
      expect(instructions).toMatch(/^ENV [^\n]*\bGIT_CONFIG_NOSYSTEM=1(?:\s|$)/m);
    });
  }

  test("standalone AIO defaults to recipes under /data and preserves its blob layout", async () => {
    const dockerfile = await read("deploy/aio/Dockerfile");
    expect(dockerfile).toContain("SPACK_RECIPE_STORE_DIR=/data/registry/recipes");
    expect(dockerfile).toContain("BLOB_STORE_DIR=/data/registry/blobs");
    expect(dockerfile).toContain('VOLUME ["/data"]');
  });
});

describe("recipe Helm storage (offline)", () => {
  test("defaults to persistent recipes without changing the existing blob mount", async () => {
    const values = parse(await read(`${chart}/values.yaml`)) as RegistryValues;
    expect(values.registry.recipes).toEqual({
      enabled: true,
      bootstrapManifest: "",
      materialBootstrapManifest: "",
    });
    expect(values.registry.persistence.enabled).toBe(true);
    expect(values.registry.persistence.mountPath).toBe("/var/lib/kuintessence/registry/blobs");
    expect(values.registry.replicas).toBe(1);
  });

  test("template gates recipe storage and bootstrap, validates single-writer persistence", async () => {
    const deployment = await read(`${chart}/templates/registry-deployment.yaml`);
    expect(deployment).toContain("if .Values.registry.recipes.enabled");
    expect(deployment).toContain(
      'fail "registry.recipes.enabled requires registry.persistence.enabled"',
    );
    expect(deployment).toContain('fail "registry.recipes.enabled requires registry.replicas=1"');
    expect(deployment).toContain("type: Recreate");
    expect(deployment).toContain("rollingUpdate: null");
    expect(deployment).toContain("name: SPACK_RECIPE_STORE_DIR");
    expect(deployment).toContain('printf "%s/recipes"');
    expect(deployment).toContain("name: SPACK_MATERIAL_STORE_DIR");
    expect(deployment).toContain('printf "%s/materials"');
    expect(deployment).toContain("if .Values.registry.recipes.bootstrapManifest");
    expect(deployment).toContain("name: SPACK_RECIPE_BOOTSTRAP_MANIFEST");
    const pvc = await read(`${chart}/templates/registry-pvc.yaml`);
    expect(pvc).toContain("name: {{ .Release.Name }}-registry-blobs");
    expect(pvc).toContain("helm.sh/resource-policy: keep");
  });

  const renderTest = helm ? test : test.skip;

  renderTest("default render preserves the blob PVC and uses a single Recreate writer", () => {
    const items = resources();
    const { deployment, pod, container, env } = registry(items);
    expect(deployment?.spec?.replicas).toBe(1);
    expect(deployment?.spec?.strategy).toEqual({ type: "Recreate", rollingUpdate: null });
    expect(env.BLOB_STORE_DIR).toBe("/var/lib/kuintessence/registry/blobs");
    expect(env.SPACK_RECIPE_STORE_DIR).toBe("/var/lib/kuintessence/registry/blobs/recipes");
    expect(env.SPACK_MATERIAL_STORE_DIR).toBe("/var/lib/kuintessence/registry/blobs/materials");
    expect(env).not.toHaveProperty("SPACK_RECIPE_BOOTSTRAP_MANIFEST");
    expect(container?.volumeMounts).toEqual([
      { name: "blob-storage", mountPath: "/var/lib/kuintessence/registry/blobs" },
    ]);
    expect(pod?.volumes).toEqual([
      { name: "blob-storage", persistentVolumeClaim: { claimName: "kq-registry-blobs" } },
    ]);
    expect(
      items.filter(
        (item) =>
          item.kind === "PersistentVolumeClaim" && item.metadata.name === "kq-registry-blobs",
      ),
    ).toHaveLength(1);
  });

  renderTest("custom mount and optional bootstrap stay local without adding a volume", () => {
    const { env, container } = registry(
      resources([
        "registry.persistence.mountPath=/srv/registry/",
        "registry.recipes.bootstrapManifest=/bootstrap/manifest.json",
      ]),
    );
    expect(env.BLOB_STORE_DIR).toBe("/srv/registry/");
    expect(env.SPACK_RECIPE_STORE_DIR).toBe("/srv/registry/recipes");
    expect(env.SPACK_RECIPE_BOOTSTRAP_MANIFEST).toBe("/bootstrap/manifest.json");
    expect(container?.volumeMounts).toEqual([
      { name: "blob-storage", mountPath: "/srv/registry/" },
    ]);
  });

  for (const [setting, message] of [
    [
      "registry.persistence.enabled=false",
      "registry.recipes.enabled requires registry.persistence.enabled",
    ],
    ["registry.replicas=2", "registry.recipes.enabled requires registry.replicas=1"],
    ["registry.replicas=0", "registry.recipes.enabled requires registry.replicas=1"],
    ["registry.replicas=1.5", "registry.recipes.enabled requires registry.replicas=1"],
    [
      "registry.persistence.mountPath=relative",
      "registry recipe storage requires an absolute mountPath",
    ],
    [
      "registry.recipes.bootstrapManifest=relative.json",
      "registry.recipes.bootstrapManifest must be an absolute local path",
    ],
  ] as const) {
    renderTest(`rejects unsafe recipe configuration: ${setting}`, () => {
      const result = render([setting]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
    });
  }

  renderTest("disabled recipes retain the legacy nonpersistent multi-replica configuration", () => {
    const items = resources([
      "registry.recipes.enabled=false",
      "registry.persistence.enabled=false",
      "registry.replicas=2",
      "registry.recipes.bootstrapManifest=/unused/manifest.json",
    ]);
    const { deployment, pod, container, env } = registry(items);
    expect(deployment?.spec?.replicas).toBe(2);
    expect(deployment?.spec?.strategy).toBeUndefined();
    expect(env).not.toHaveProperty("SPACK_RECIPE_STORE_DIR");
    expect(env).not.toHaveProperty("SPACK_MATERIAL_STORE_DIR");
    expect(env).not.toHaveProperty("SPACK_RECIPE_BOOTSTRAP_MANIFEST");
    expect(env).not.toHaveProperty("BLOB_STORE_DIR");
    expect(container?.volumeMounts).toBeUndefined();
    expect(pod?.volumes).toBeUndefined();
    expect(items.some((item) => item.metadata.name === "kq-registry-blobs")).toBe(false);
  });

  renderTest("disabling the Registry does not require recipe persistence or a writer", () => {
    const items = resources([
      "registry.enabled=false",
      "registry.persistence.enabled=false",
      "registry.replicas=0",
    ]);
    expect(items.some((item) => item.metadata.name === "kq-registry")).toBe(false);
    expect(items.some((item) => item.metadata.name === "kq-registry-blobs")).toBe(false);
  });
});
