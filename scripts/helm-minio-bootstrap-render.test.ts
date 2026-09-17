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

describe("Helm MinIO bootstrap render", () => {
  test("uses one ConfigMap script for the Job and its upgrade-safe wait dependency", async () => {
    const [chartScript, sharedScript, bootstrap, server, config, helpers, values] =
      await Promise.all([
        read(`${chartDir}/files/bootstrap-object-lock.sh`),
        read("deploy/minio/bootstrap-object-lock.sh"),
        read(`${chartDir}/templates/minio-bootstrap.yaml`),
        read(`${chartDir}/templates/server-deployment.yaml`),
        read(`${chartDir}/templates/configmap.yaml`),
        read(`${chartDir}/templates/_helpers.tpl`),
        read(`${chartDir}/values.yaml`),
      ]);

    expect(chartScript).toBe(sharedScript);
    expect(bootstrap).toContain("kind: Job");
    expect(bootstrap).toContain("image: {{ .Values.minio.mcImage | quote }}");
    expect(bootstrap).toContain("bootstrap-object-lock.sh: |-");
    expect(bootstrap).toContain("DATA_MARKET_STAGING_EXPIRY_DAYS");
    expect(bootstrap).toContain("DATA_MARKET_IMMUTABLE_RETENTION_DAYS");
    expect(server).toContain("name: wait-minio-bootstrap");
    expect(server).toContain("kubectl wait --for=condition=complete --timeout=15m");
    expect(helpers).toContain("sha256sum");
    expect(helpers).toContain("minioBootstrapName");
    expect(config).toContain("DATA_MARKET_IMMUTABLE_RETENTION_DAYS");
    expect(values).toContain("dataMarketStagingExpiryDays: 1");
    expect(values).toContain("dataMarketImmutableRetentionDays: 365");
  });

  test("renders bootstrap resources only for self-hosted MinIO NetDrive", () => {
    const disabled = render([]);
    const selfHosted = render(["--set", "netdrive.enabled=true"]);
    const external = render([
      "--set",
      "minio.enabled=false",
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

    expect(disabled).not.toContain("app.kubernetes.io/component: minio-bootstrap");
    expect(disabled).not.toContain("name: wait-minio-bootstrap");
    expect(selfHosted).toContain("app.kubernetes.io/component: minio-bootstrap");
    expect(selfHosted).toContain("name: wait-minio-bootstrap");
    expect(selfHosted).toContain('value: "1"');
    expect(selfHosted).toContain('value: "365"');
    expect(external).not.toContain("app.kubernetes.io/component: minio-bootstrap");
    expect(external).not.toContain("name: wait-minio-bootstrap");
    expect(external).toContain('NETDRIVE_ENDPOINT: "s3.example.com"');
    expect(external).toContain('DATA_MARKET_STAGING_EXPIRY_DAYS: "1"');
    expect(external).toContain('DATA_MARKET_IMMUTABLE_RETENTION_DAYS: "365"');
  });
});
