import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (path: string): Promise<string> => Bun.file(path).text();

async function runBootstrapMock(options: { failCommand?: string; failCors?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kq-minio-bootstrap-"));
  const mc = join(dir, "mc");
  const log = join(dir, "mc.log");
  await writeFile(
    mc,
    `#!/usr/bin/env sh
set -eu
command="$1 \${2:-}"
printf '%s\\n' "$command" >> "$MC_LOG"
if [ "${options.failCommand ?? ""}" = "$command" ]; then exit 1; fi
if [ "${options.failCors ? "1" : "0"}" = "1" ] && [ "$command" = "cors set" ]; then exit 1; fi
if [ "$command" = "retention info" ]; then
  echo "Object locking 'COMPLIANCE' is configured for 365DAYS."
fi
if [ "$command" = "admin user" ]; then
  echo "policy: kq-data-market-committer-policy"
fi
`,
    { mode: 0o755 },
  );
  try {
    const result = Bun.spawnSync({
      cmd: ["sh", "deploy/minio/bootstrap-object-lock.sh"],
      cwd: ".",
      env: {
        ...process.env,
        DATA_MARKET_IMMUTABLE_BUCKET: "immutable",
        DATA_MARKET_IMMUTABLE_RETENTION_DAYS: "365",
        DATA_MARKET_COMMITTER_SECRET_KEY: "committer-secret",
        DATA_MARKET_STAGING_BUCKET: "staging",
        DATA_MARKET_STAGING_EXPIRY_DAYS: "1",
        MC_LOG: log,
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_ROOT_PASSWORD: "password",
        MINIO_ROOT_USER: "user",
        NETDRIVE_BUCKET: "netdrive",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: result.exitCode,
      log: await readFile(log, "utf8"),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("MinIO Object Lock bootstrap wiring", () => {
  test("initialization script separates deleteable staging from immutable content", async () => {
    const script = await read("deploy/minio/bootstrap-object-lock.sh");

    expect(script).toContain("mc mb --ignore-existing --with-lock");
    expect(script).toContain("mc version enable");
    expect(script).toContain("DATA_MARKET_STAGING_BUCKET must differ");
    expect(script).toContain("NETDRIVE_BUCKET must differ from Data Market buckets");
    expect(script).toContain("mc ilm rule add --expire-days");
    expect(script).toContain(`"local/\${staging_bucket}"`);
    expect(script).toContain(`"local/\${immutable_bucket}"`);
    expect(script).toContain('"s3:x-amz-copy-source"');
    expect(script).toContain('"s3:object-lock-mode": "COMPLIANCE"');
    expect(script).toContain('"s3:GetObjectVersion"');
    expect(script).toContain('"s3:DeleteObject", "s3:DeleteObjectVersion"');
    expect(script).toContain("mc admin user add");
    expect(script).toContain("mc admin policy create");
    expect(script).toContain("mc admin policy attach");
    expect(script).toContain("mc retention set --default COMPLIANCE");
    expect(script).toContain("DATA_MARKET_IMMUTABLE_BUCKET must support COMPLIANCE Object Lock");
    expect(script).toContain("configure_cors() {");
    expect(script).toContain(`if ! mc cors set "local/\${bucket}"`);
    expect(script).toContain("configure and verify equivalent browser CORS separately");
    expect(script).not.toContain("|| true");
    expect(await read("deploy/helm/kq-platform/files/bootstrap-object-lock.sh")).toBe(script);
  });

  test("scheduler Server waits for successful object storage initialization", async () => {
    const compose = await read("deploy/compose/docker-compose.schedulers.yml");
    const server = compose.slice(compose.indexOf("  server:"), compose.indexOf("\n  registry:"));

    expect(compose).toContain("minio-init:");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("bootstrap-object-lock.sh:/bootstrap-object-lock.sh:ro");
    expect(server).toContain("minio-init:");
    expect(server).toContain("condition: service_completed_successfully");
  });

  test("scheduler CORS proxy preserves the host signed into browser upload URLs", async () => {
    const compose = await read("deploy/compose/docker-compose.schedulers.yml");
    const proxy = await read("deploy/minio/cors-proxy.conf");

    expect(compose).toContain("minio-cors:");
    expect(compose).toContain(`"\${KQ_SCHEDULER_MINIO_API_PORT:-9000}:8080"`);
    expect(compose).toContain("minio-cors:\n        condition: service_healthy");
    expect(proxy).toContain("if ($request_method = OPTIONS)");
    expect(proxy).toContain('Access-Control-Allow-Methods "GET, PUT, HEAD"');
    expect(proxy).toContain("proxy_set_header Host $http_host");
    expect(proxy).toContain("proxy_hide_header Access-Control-Allow-Origin");
    expect(proxy).toContain('Access-Control-Expose-Headers "ETag"');
  });

  test("AIO initializes the same controls before starting Server", async () => {
    const entrypoint = await read("deploy/aio/entrypoint.sh");
    const dockerfile = await read("deploy/aio/Dockerfile");
    const compose = await read("deploy/compose/docker-compose.aio.yml");

    expect(entrypoint.indexOf("bootstrap-object-lock")).toBeGreaterThan(
      entrypoint.indexOf('log "starting minio"'),
    );
    expect(entrypoint.indexOf("bootstrap-object-lock")).toBeLessThan(
      entrypoint.indexOf('log "starting server"'),
    );
    expect(dockerfile).toContain("COPY --from=minio-mc /usr/bin/mc /usr/local/bin/mc");
    expect(dockerfile).toContain("NETDRIVE_ENABLED=true");
    expect(dockerfile).toContain("DATA_MARKET_IMMUTABLE_RETENTION_DAYS=365");
    expect(compose).toContain("DATA_MARKET_COMMITTER_SECRET_KEY");
    expect(compose).toContain("KQ_DATA_MARKET_COMMITTER_SECRET_KEY is required");
  });

  test("Helm carries the ordinary IAM identity and an explicit credential rotation revision", async () => {
    const configMap = await read("deploy/helm/kq-platform/templates/configmap.yaml");
    const serverDeployment = await read("deploy/helm/kq-platform/templates/server-deployment.yaml");
    const helpers = await read("deploy/helm/kq-platform/templates/_helpers.tpl");
    const values = await read("deploy/helm/kq-platform/values.yaml");

    expect(configMap).toContain("DATA_MARKET_COMMITTER_ACCESS_KEY");
    expect(helpers).toContain(".Values.netdrive.accessKey");
    expect(helpers).toContain(".Values.netdrive.bootstrapRevision");
    expect(serverDeployment).toContain("kq.io/netdrive-bootstrap-revision");
    expect(serverDeployment).toContain(".Values.netdrive.bootstrapRevision");
    expect(values).toContain('bootstrapRevision: "1"');
  });

  test("continues after a CORS failure while applying the immutable controls", async () => {
    const result = await runBootstrapMock({ failCors: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("configure and verify equivalent browser CORS separately");
    expect(result.log).toContain("retention set");
    expect(result.log).toContain("ilm rule");
    expect(result.log).toContain("admin policy");
  });

  test.each([
    "version enable",
    "retention set",
    "ilm rule",
    "admin policy",
    "admin user",
  ])("fails when %s cannot enforce its control", async (failCommand) => {
    const result = await runBootstrapMock({ failCommand });

    expect(result.exitCode).not.toBe(0);
  });
});
