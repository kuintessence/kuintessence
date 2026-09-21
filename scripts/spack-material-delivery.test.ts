import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import pino from "pino";
import { parse, parseAllDocuments } from "yaml";
import { SpackManager } from "../packages/agent/src/spack";
import { SpackMaterialClient } from "../packages/agent/src/spack/material-client";
import { preflightSpackMaterials } from "../packages/agent/src/spack/material-preflight";
import { loadRegistryConfig } from "../packages/registry/src/config";
import {
  cleanupMaterials,
  materialApp,
  materialFixture,
} from "../packages/registry/src/routes/spack-materials.test-helpers";
import { ORG, OWNER } from "../packages/registry/src/routes/spack-repositories.test-helpers";
import { createErrorHandler } from "../packages/server/src/middleware/error-handler";
import { createAgentSpackMaterialRoutes } from "../packages/server/src/routes/agent-spack-materials";
import { SpackMaterialDelivery } from "../packages/server/src/software-governance/spack-material-delivery";

const directories: string[] = [];
const root = fileURLToPath(new URL("../", import.meta.url));
const chart = "deploy/helm/kq-platform";
const helm = Bun.which("helm");

interface HelmResource {
  kind: string;
  metadata: { name: string };
  spec?: {
    template?: {
      spec: {
        containers: {
          name: string;
          env: { name: string; value?: string }[];
          volumeMounts?: { name: string; mountPath: string }[];
        }[];
        volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
      };
    };
  };
}

function renderMaterialHelm(settings: string[] = []) {
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

function materialHelmRegistry(settings: string[] = []) {
  const result = renderMaterialHelm(settings);
  expect(result.code, result.stderr).toBe(0);
  const resources = parseAllDocuments(result.stdout).map((document) => {
    expect(document.errors).toEqual([]);
    return document.toJS() as HelmResource;
  });
  const pod = resources.find(
    (item) => item.kind === "Deployment" && item.metadata.name === "kq-registry",
  )?.spec?.template?.spec;
  const container = pod?.containers.find((item) => item.name === "registry");
  expect(container).toBeDefined();
  return {
    pod,
    container,
    env: Object.fromEntries(container?.env.map((item) => [item.name, item.value]) ?? []),
  };
}

afterEach(async () => {
  await cleanupMaterials();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Spack material pipeline (in-process, no listeners)", () => {
  test("Registry publication reaches Agent only through Server and never executes install", async () => {
    const f = await materialFixture();
    await f.seed();
    const actor = { ...OWNER, sub: "44444444-4444-4444-8444-444444444444", suspended: false };
    const binding = await f.store.publish(f.input, actor);
    const key = "fixture-registry-key".repeat(3);
    const registry = materialApp(f.store, {
      authMode: "jwt",
      allowTestHeader: false,
      jwtSecret: key,
      resolveCanonicalPrincipal: async (subject) => (subject === actor.sub ? actor : null),
    });
    const operationId = "55555555-5555-4555-8555-555555555555";
    const access = {
      agentId: "fixture-agent",
      requestedBy: actor.sub,
      providerOrgId: ORG,
      spec: f.input.spec,
    };
    const registryCalls: string[] = [];
    let registered = false;
    let acquiredReferences = 0;
    const delivery = new SpackMaterialDelivery({
      registryUrl: "https://registry.internal",
      registryJwtSecret: key,
      ticketSecret: "fixture-operation-ticket".repeat(3),
      bindings: { [f.input.spec]: binding },
      references: {
        async registerBindings(bindings) {
          expect(bindings).toEqual({ [f.input.spec]: binding });
          registered = true;
        },
        async acquireOperation(input) {
          expect(registered).toBe(true);
          expect(input).toEqual({
            operationId,
            agentId: access.agentId,
            requestedBy: access.requestedBy,
            spec: access.spec,
            ...binding,
          });
          acquiredReferences++;
        },
      },
      access: { operation: async () => access, certificate: async () => true },
      dispatcher: {
        getChannel: () => ({
          push() {},
          close() {},
          spackMaterialDeliveryV1: true,
          verifiedCertFingerprint: "f".repeat(64),
        }),
      },
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          registryCalls.push(String(url));
          return registry.request(String(url), init);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const ticket = await delivery.prepareOperation({ operationId, ...access });
    const server = new Hono();
    server.onError(createErrorHandler(pino({ level: "silent" })));
    server.route("/api", createAgentSpackMaterialRoutes(delivery));
    const root = await mkdtemp(join(await realpath(tmpdir()), "kq-pipeline-"));
    directories.push(root);
    const agentCalls: string[] = [];
    const agentFetch = async (url: string, init: RequestInit) => {
      agentCalls.push(url);
      expect(new URL(url).origin).toBe("https://server.example.invalid");
      expect(init.redirect).toBe("error");
      return server.request(url, init);
    };
    const clientOptions = {
      serverUrl: "https://server.example.invalid",
      cacheDir: join(root, "cache"),
      fetch: agentFetch,
    };
    const client = new SpackMaterialClient(clientOptions);
    const input = {
      operationId,
      ticket: ticket.spackMaterialTicket,
      manifestDigest: ticket.spackManifestDigest,
      spec: f.input.spec,
      spackVersion: f.input.spackVersion,
    };
    const prepared = await client.prepare(input);
    expect(await preflightSpackMaterials(prepared, input)).toMatchObject({
      validation: "static-only",
      valid: true,
      nodeCount: 1,
    });
    expect(prepared.blobs).toHaveLength(3);
    expect(JSON.parse(await readFile(prepared.manifestPath, "utf8")).recipes[0].commit).toBe(
      f.input.recipes[0]?.commit,
    );
    expect(
      agentCalls.every((url) => url.includes(`/api/agent/spack/operations/${operationId}/`)),
    ).toBe(true);
    expect(registryCalls.every((url) => url.startsWith("https://registry.internal/"))).toBe(true);
    expect(acquiredReferences).toBeGreaterThan(1);

    agentCalls.length = 0;
    await new SpackMaterialClient(clientOptions).prepare(input);
    expect(agentCalls).toEqual([
      `https://server.example.invalid/api/agent/spack/operations/${operationId}/manifest`,
    ]);

    const commands: string[][] = [];
    const manager = await SpackManager.bootstrap({
      enabled: true,
      requireServerMaterials: true,
      materialClient: client,
      spawner: {
        run: async (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: f.input.spackVersion, stderr: "" };
        },
      },
    });
    const outcome = await manager.runSoftwareOperation("install", f.input.spec, input);
    expect(outcome).toEqual({
      outcome: "rejected",
      reason: "managed offline Spack execution is not enabled yet",
    });
    expect(commands).toEqual([["spack", "--version"]]);

    actor.suspended = true;
    await expect(client.prepare(input)).rejects.toThrow("HTTP 502");
    expect(commands).toEqual([["spack", "--version"]]);
  }, 30_000);
});

describe("Spack material deployment wiring (offline)", () => {
  for (const filename of [
    "docker-compose.yml",
    "docker-compose.schedulers.yml",
    "docker-compose.preview.yml",
    "docker-compose.aio.yml",
  ]) {
    test(`${filename} persists materials on its existing Registry data volume`, async () => {
      const config = parse(await Bun.file(`deploy/compose/${filename}`).text()) as {
        services: Record<string, { environment: Record<string, string>; volumes: string[] }>;
      };
      const service = config.services.registry ?? config.services.kq;
      const material = service?.environment.SPACK_MATERIAL_STORE_DIR;
      expect(service?.environment.SPACK_MATERIAL_BOOTSTRAP_MANIFEST).toBe(
        `\${SPACK_MATERIAL_BOOTSTRAP_MANIFEST:-}`,
      );
      expect(material).toBe(
        filename.includes(".aio.")
          ? "/data/registry/materials"
          : "/var/lib/kuintessence/registry/materials",
      );
      expect(
        service?.volumes.some((volume) => {
          const destination = volume.split(":")[1];
          return destination && material?.startsWith(`${destination}/`);
        }),
      ).toBe(true);
      expect(() =>
        loadRegistryConfig({
          DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
          BLOB_STORE_DIR: service?.environment.BLOB_STORE_DIR ?? "/data/registry/blobs",
          SPACK_RECIPE_STORE_DIR: service?.environment.SPACK_RECIPE_STORE_DIR,
          SPACK_MATERIAL_STORE_DIR: material,
          SPACK_MATERIAL_BOOTSTRAP_MANIFEST: "/material-bootstrap/manifest.json",
        }),
      ).not.toThrow();
    });
  }
  test("Nginx streams material uploads and Agent downloads without changing recipe limits", async () => {
    for (const file of ["packages/web/nginx.conf", "deploy/aio/nginx.conf"]) {
      const content = await Bun.file(file).text();
      expect(content).toContain("location ^~ /software/api/spack/material-repositories/");
      expect(content).toContain("client_max_body_size 16g;");
      expect(content).toContain("proxy_request_buffering off;");
      expect(content).toContain("location ^~ /api/agent/spack/operations/");
      expect(content).toContain("proxy_buffering off;");
      expect(content).toContain("client_max_body_size 128m;");
    }
  });
});

describe("Spack material bootstrap Helm wiring (offline)", () => {
  test("defaults to an empty manifest and gates its environment variable", async () => {
    const values = parse(await Bun.file(resolve(root, chart, "values.yaml")).text()) as {
      registry: { recipes: { materialBootstrapManifest: string } };
    };
    expect(values.registry.recipes.materialBootstrapManifest).toBe("");
    const template = await Bun.file(
      resolve(root, chart, "templates/registry-deployment.yaml"),
    ).text();
    expect(template).toContain("if .Values.registry.recipes.materialBootstrapManifest");
    expect(template).toContain("name: SPACK_MATERIAL_BOOTSTRAP_MANIFEST");
    expect(template).toContain(
      "value: {{ .Values.registry.recipes.materialBootstrapManifest | quote }}",
    );
    expect(template).toContain(
      'fail "registry.recipes.materialBootstrapManifest must be an absolute local path"',
    );
  });

  const renderTest = helm ? test : test.skip;

  renderTest("empty manifest does not inject a material bootstrap environment variable", () => {
    expect(materialHelmRegistry().env).not.toHaveProperty("SPACK_MATERIAL_BOOTSTRAP_MANIFEST");
  });

  renderTest("explicit manifests only add environment variables, not volumes or mounts", () => {
    const { env, pod, container } = materialHelmRegistry([
      "registry.persistence.mountPath=/srv/registry/",
      "registry.recipes.bootstrapManifest=/recipe-bootstrap/manifest.json",
      "registry.recipes.materialBootstrapManifest=/material-bootstrap/manifest.json",
    ]);
    expect(env.SPACK_RECIPE_BOOTSTRAP_MANIFEST).toBe("/recipe-bootstrap/manifest.json");
    expect(env.SPACK_MATERIAL_BOOTSTRAP_MANIFEST).toBe("/material-bootstrap/manifest.json");
    expect(env.SPACK_MATERIAL_STORE_DIR).toBe("/srv/registry/materials");
    expect(() =>
      loadRegistryConfig({
        DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
        BLOB_STORE_DIR: env.BLOB_STORE_DIR,
        SPACK_RECIPE_STORE_DIR: env.SPACK_RECIPE_STORE_DIR,
        SPACK_MATERIAL_STORE_DIR: env.SPACK_MATERIAL_STORE_DIR,
        SPACK_RECIPE_BOOTSTRAP_MANIFEST: env.SPACK_RECIPE_BOOTSTRAP_MANIFEST,
        SPACK_MATERIAL_BOOTSTRAP_MANIFEST: env.SPACK_MATERIAL_BOOTSTRAP_MANIFEST,
      }),
    ).not.toThrow();
    expect(container?.volumeMounts).toEqual([
      { name: "blob-storage", mountPath: "/srv/registry/" },
    ]);
    expect(pod?.volumes).toEqual([
      { name: "blob-storage", persistentVolumeClaim: { claimName: "kq-registry-blobs" } },
    ]);
  });

  renderTest("material bootstrap can reference recipes already stored in the PVC", () => {
    const { env } = materialHelmRegistry([
      "registry.recipes.materialBootstrapManifest=/material-bootstrap/manifest.json",
    ]);
    expect(env.SPACK_MATERIAL_BOOTSTRAP_MANIFEST).toBe("/material-bootstrap/manifest.json");
    expect(env).not.toHaveProperty("SPACK_RECIPE_BOOTSTRAP_MANIFEST");
  });

  for (const manifest of ["relative.json", "https://example.invalid/manifest.json"]) {
    renderTest(`rejects a nonabsolute material bootstrap local path: ${manifest}`, () => {
      const result = renderMaterialHelm([`registry.recipes.materialBootstrapManifest=${manifest}`]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "registry.recipes.materialBootstrapManifest must be an absolute local path",
      );
    });
  }

  renderTest("disabled recipes do not inject material bootstrap configuration", () => {
    const { env } = materialHelmRegistry([
      "registry.recipes.materialBootstrapManifest=/material-bootstrap/manifest.json",
      "registry.recipes.enabled=false",
    ]);
    expect(env).not.toHaveProperty("SPACK_MATERIAL_BOOTSTRAP_MANIFEST");
    expect(env).not.toHaveProperty("SPACK_MATERIAL_STORE_DIR");
  });
});
