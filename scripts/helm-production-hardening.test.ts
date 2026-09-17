import { describe, expect, test } from "bun:test";

const chartDir = "deploy/helm/kq-platform";
const helmPath = Bun.which("helm");
const decoder = new TextDecoder();

const read = (path: string): Promise<string> => Bun.file(path).text();

function renderProduction(): string | null {
  if (!helmPath) return null;
  const result = Bun.spawnSync({
    cmd: [
      helmPath,
      "template",
      "kq",
      chartDir,
      "-f",
      `${chartDir}/values.production.yaml`,
      "--set-string",
      "server.env.MTLS_TRUSTED_PROXY_CIDRS=10.42.7.18/32",
    ],
    cwd: ".",
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, decoder.decode(result.stderr)).toBe(0);
  return decoder.decode(result.stdout);
}

describe("Helm production hardening", () => {
  test("renders a gated migration and durable authenticated Registry", async () => {
    const [migration, server, registry, config, production] = await Promise.all([
      read(`${chartDir}/templates/db-migration.yaml`),
      read(`${chartDir}/templates/server-deployment.yaml`),
      read(`${chartDir}/templates/registry-deployment.yaml`),
      read(`${chartDir}/templates/configmap.yaml`),
      read(`${chartDir}/values.production.yaml`),
    ]);
    expect(migration).toContain("app.kubernetes.io/component: db-migration");
    expect(server).toContain("name: wait-db-migration");
    expect(registry).toContain("name: wait-db-migration");
    expect(registry).toContain("name: REGISTRY_JWT_SECRET");
    expect(registry).toContain("name: BLOB_STORE_DIR");
    expect(config).toContain("REGISTRY_AUTH_MODE");
    expect(production).toContain("replicas: 1");
    expect(production).toContain("enabled: false");
  });

  test("production render has one application replica and no HPA", () => {
    const rendered = renderProduction();
    if (!rendered) return;
    expect(rendered).toContain("name: kq-db-migrate-r1");
    expect(rendered).toContain("claimName: kq-registry-blobs");
    expect(rendered).toContain('REGISTRY_AUTH_MODE: "jwt"');
    expect(rendered).not.toContain("kind: HorizontalPodAutoscaler");
    expect(rendered.match(/replicas: 1/g)?.length).toBe(2);
  });
});
