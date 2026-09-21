import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

interface Compose {
  services: Record<string, { environment?: Record<string, string> }>;
}

interface Values {
  registry: {
    upstream: {
      enabled: boolean;
      proxySecretRef: { name: string; key: string };
      allowedOrigins: string[];
      timeoutMs: number;
      idleTimeoutMs: number;
      maxConcurrent: number;
      maxBytes: number;
      caBundle: string;
    };
  };
}

describe("Spack upstream deployment wiring (offline, no process execution)", () => {
  for (const [file, name] of [
    ["docker-compose.yml", "registry"],
    ["docker-compose.aio.yml", "kq"],
  ] as const) {
    test(`${file} exposes opt-in importer settings without committed credentials`, async () => {
      const config = parse(await read(`deploy/compose/${file}`)) as Compose;
      const env = config.services[name]?.environment;
      expect(env?.SPACK_UPSTREAM_ENABLED).toBe("${SPACK_UPSTREAM_ENABLED:-false}");
      expect(env?.SPACK_UPSTREAM_PROXY_URL).toBe("${SPACK_UPSTREAM_PROXY_URL:-}");
      expect(env?.SPACK_UPSTREAM_ALLOWED_ORIGINS).toBe("${SPACK_UPSTREAM_ALLOWED_ORIGINS:-[]}");
      expect(env?.SPACK_UPSTREAM_TIMEOUT_MS).toBe("${SPACK_UPSTREAM_TIMEOUT_MS:-300000}");
      expect(env?.SPACK_UPSTREAM_IDLE_TIMEOUT_MS).toBe("${SPACK_UPSTREAM_IDLE_TIMEOUT_MS:-30000}");
      expect(env?.SPACK_UPSTREAM_MAX_CONCURRENT).toBe("${SPACK_UPSTREAM_MAX_CONCURRENT:-2}");
      expect(env?.SPACK_UPSTREAM_MAX_BYTES).toBe("${SPACK_UPSTREAM_MAX_BYTES:-1073741824}");
      expect(env?.SPACK_UPSTREAM_CA_BUNDLE).toBe("${SPACK_UPSTREAM_CA_BUNDLE:-}");
      expect(env).not.toHaveProperty("HTTP_PROXY");
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env).not.toHaveProperty("ALL_PROXY");
    });
  }

  for (const file of [
    "docker-compose.preview.yml",
    "docker-compose.pr-test.yml",
    "docker-compose.schedulers.yml",
  ]) {
    test(`${file} disables upstream downloads and does not inherit proxy credentials`, async () => {
      const config = parse(await read(`deploy/compose/${file}`), { merge: true }) as Compose;
      expect(config.services.registry?.environment?.SPACK_UPSTREAM_ENABLED).toBe("false");
      expect(config.services.registry?.environment).not.toHaveProperty("SPACK_UPSTREAM_PROXY_URL");
    });
  }

  test("watch inherits the main Registry settings and does not copy secrets to Web", async () => {
    const config = parse(await read("deploy/compose/docker-compose.watch.yml"), {
      merge: true,
      logLevel: "silent",
    }) as Compose;
    expect(config.services.registry?.environment).not.toHaveProperty("SPACK_UPSTREAM_ENABLED");
    expect(config.services.web?.environment).not.toHaveProperty("SPACK_UPSTREAM_PROXY_URL");
  });

  for (const file of [
    "packages/registry/Dockerfile",
    "deploy/aio/Dockerfile",
    "deploy/dev/Dockerfile",
  ]) {
    test(`${file} provides curl and target TLS roots in its final runtime`, async () => {
      const runtime = (await read(file)).split(/^FROM /m).at(-1) ?? "";
      const instructions = runtime.replace(/\\\r?\n\s*/g, " ");
      expect(instructions).toMatch(/^RUN apk add --no-cache [^\n]*\bcurl\b/m);
      expect(instructions).toMatch(/^RUN apk add --no-cache [^\n]*\bca-certificates\b/m);
    });
  }

  test("PR workspace inherits curl and CA certificates with pinned runtimes", async () => {
    const workspace = await read("deploy/pr-test/workspace.Dockerfile");
    const base = await read("deploy/schedulers/base/Dockerfile");
    expect(workspace).toMatch(/^FROM scheduler-base/m);
    expect(workspace).toContain('test "$(spack --version)" = "1.0.0"');
    expect(workspace).toContain('test "$(bun --version)" = "1.4.2"');
    expect(base).toMatch(/^\s+curl\s+\\/m);
    expect(base).toMatch(/^\s+ca-certificates\s+\\/m);
    expect(base).toContain("ARG BUN_VERSION=1.4.2");
  });

  test("Helm is disabled by default and uses only an existing Secret reference", async () => {
    const values = parse(await read("deploy/helm/kq-platform/values.yaml")) as Values;
    expect(values.registry.upstream).toEqual({
      enabled: false,
      proxySecretRef: { name: "", key: "SPACK_UPSTREAM_PROXY_URL" },
      allowedOrigins: [],
      timeoutMs: 300000,
      idleTimeoutMs: 30000,
      maxConcurrent: 2,
      maxBytes: 1073741824,
      caBundle: "",
    });
    const deployment = await read("deploy/helm/kq-platform/templates/registry-deployment.yaml");
    expect(deployment).toMatch(
      /name: SPACK_UPSTREAM_PROXY_URL\s+valueFrom:\s+secretKeyRef:\s+name: {{ \.Values\.registry\.upstream\.proxySecretRef\.name \| quote }}\s+key: {{ \.Values\.registry\.upstream\.proxySecretRef\.key \| quote }}/,
    );
    expect(deployment).toContain(
      'fail "registry.upstream.enabled requires registry.recipes.enabled"',
    );
    expect(deployment).toContain(
      'fail "registry.upstream.proxySecretRef.name is required when upstream imports are enabled"',
    );
    expect(deployment).toContain(
      'fail "registry.upstream.allowedOrigins must not be empty when upstream imports are enabled"',
    );
    expect(deployment).toContain(
      "value: {{ .Values.registry.upstream.allowedOrigins | toJson | quote }}",
    );
    expect(deployment).toContain(
      'fail "registry.upstream.caBundle must be an absolute container path"',
    );
    const configmap = await read("deploy/helm/kq-platform/templates/configmap.yaml");
    const server = await read("deploy/helm/kq-platform/templates/server-deployment.yaml");
    expect(configmap).not.toContain("SPACK_UPSTREAM_");
    expect(server).not.toContain("SPACK_UPSTREAM_");
  });
});
