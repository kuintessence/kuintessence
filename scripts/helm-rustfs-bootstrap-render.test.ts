import { describe, expect, test } from "bun:test";

const chartDir = "deploy/helm/kq-platform";
const helmPath = Bun.which("helm");
const decoder = new TextDecoder();

const read = (path: string): Promise<string> => Bun.file(path).text();

const render = (args: string[]): string | null => {
  if (!helmPath) return null;

  const result = Bun.spawnSync({
    cmd: [helmPath, "template", "kq", chartDir, "-f", `${chartDir}/values.testing.yaml`, ...args],
    cwd: ".",
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode, decoder.decode(result.stderr)).toBe(0);
  return decoder.decode(result.stdout);
};

describe("Helm RustFS bootstrap render", () => {
  test("renders non-root RustFS with a new PVC identity and native health checks", () => {
    const rendered = render([]);
    if (!rendered) return;
    expect(rendered).toContain("name: kq-rustfs");
    expect(rendered).toContain("image: rustfs/rustfs:1.0.0");
    expect(rendered).toContain("runAsUser: 10001");
    expect(rendered).toContain("fsGroup: 10001");
    expect(rendered).toContain("path: /health");
    expect(rendered).not.toContain("name: kq-minio");
  });

  test("rejects legacy values rather than silently enabling a new storage backend", () => {
    if (!helmPath) return;
    const result = Bun.spawnSync({
      cmd: [
        helmPath,
        "template",
        "kq",
        chartDir,
        "-f",
        `${chartDir}/values.testing.yaml`,
        "--set",
        "minio.enabled=false",
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stderr)).toContain("migrate data separately");
  });

  test("uses one ConfigMap script for the Job and its upgrade-safe wait dependency", async () => {
    const [chartScript, sharedScript, bootstrap, server, config, helpers, values] = await Promise.all([
      read(`${chartDir}/files/bootstrap-object-lock.sh`),
      read("deploy/rustfs/bootstrap-object-lock.sh"),
      read(`${chartDir}/templates/rustfs-bootstrap.yaml`),
      read(`${chartDir}/templates/server-deployment.yaml`),
      read(`${chartDir}/templates/configmap.yaml`),
      read(`${chartDir}/templates/_helpers.tpl`),
      read(`${chartDir}/values.yaml`),
    ]);

    expect(chartScript).toBe(sharedScript);
    expect(bootstrap).toContain("kind: Job");
    expect(bootstrap).toContain("image: {{ .Values.rustfs.rcImage | quote }}");
    expect(bootstrap).toContain("bootstrap-object-lock.sh: |-");
    expect(bootstrap).toContain("DATA_MARKET_STAGING_EXPIRY_DAYS");
    expect(bootstrap).toContain("DATA_MARKET_IMMUTABLE_RETENTION_DAYS");
    expect(server).toContain("name: wait-rustfs-bootstrap");
    expect(server).toContain("kubectl wait --for=condition=complete --timeout=15m");
    expect(helpers).toContain("sha256sum");
    expect(helpers).toContain("rustfsBootstrapName");
    expect(config).toContain("DATA_MARKET_IMMUTABLE_RETENTION_DAYS");
    expect(values).toContain("dataMarketStagingExpiryDays: 1");
    expect(values).toContain("dataMarketImmutableRetentionDays: 365");
  });

  test("renders bootstrap resources only for self-hosted RustFS NetDrive", () => {
    const disabled = render([]);
    const selfHosted = render([
      "--set",
      "netdrive.enabled=true",
      "--set",
      "netdrive.accessKey=test-access-key",
      "--set",
      "netdrive.secretKey=test-secret-key",
    ]);
    const external = render([
      "--set",
      "rustfs.enabled=false",
      "--set",
      "netdrive.enabled=true",
      "--set",
      "netdrive.endpoint=s3.example.com",
      "--set",
      "netdrive.accessKey=test-access-key",
      "--set",
      "netdrive.secretKey=test-secret-key",
    ]);

    if (!helmPath) return;

    expect(disabled).not.toContain("app.kubernetes.io/component: rustfs-bootstrap");
    expect(disabled).not.toContain("name: wait-rustfs-bootstrap");
    expect(selfHosted).toContain("app.kubernetes.io/component: rustfs-bootstrap");
    expect(selfHosted).toContain("name: wait-rustfs-bootstrap");
    expect(selfHosted).toContain('value: "1"');
    expect(selfHosted).toContain('value: "365"');
    expect(external).not.toContain("app.kubernetes.io/component: rustfs-bootstrap");
    expect(external).not.toContain("name: wait-rustfs-bootstrap");
    expect(external).toContain('NETDRIVE_ENDPOINT: "s3.example.com"');
    expect(external).toContain('DATA_MARKET_STAGING_EXPIRY_DAYS: "1"');
    expect(external).toContain('DATA_MARKET_IMMUTABLE_RETENTION_DAYS: "365"');
  });
});
