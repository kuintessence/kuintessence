import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform = "deploy/helm/kq-platform";
const wrapper = "deploy/helm/kq-preview";
const read = (path: string) => Bun.file(resolve(root, path)).text();

interface Values {
  preview: { enabled: boolean; host: string; credentialsRevision: string };
  seed: { enabled: boolean; mode: string };
  scheduler: { enabled: boolean };
  secrets: { existingSecret: string };
  global: { imagePullSecrets: { name: string }[]; nodeSelector: Record<string, string> };
  server: { env: { NODE_ENV: string; MTLS_MODE: string } };
  ingress: { className: string; tls: unknown[] };
}

describe("Helm preview source contracts", () => {
  test("CI wrapper depends on the user chart and does not duplicate templates", async () => {
    const chart = parse(await read(`${wrapper}/Chart.yaml`)) as {
      dependencies: { name: string; repository: string; version: string }[];
    };
    expect(chart.dependencies).toEqual([
      { name: "kq-platform", version: "0.1.0", repository: "file://../kq-platform" },
    ]);
    const templates: string[] = [];
    for await (const path of new Bun.Glob("templates/**/*").scan({ cwd: resolve(root, wrapper) })) {
      templates.push(path);
    }
    expect(templates).toEqual([]);
    const user = parse(await read(`${platform}/values.yaml`)) as Values;
    const preview = (parse(await read(`${wrapper}/values.yaml`)) as { "kq-platform": Values })[
      "kq-platform"
    ];
    expect(user.server.env.NODE_ENV).toBe("production");
    expect(user.seed.mode).toBe("minimal");
    expect(user.preview.enabled).toBe(false);
    expect(user.scheduler.enabled).toBe(false);
    expect(preview.server.env.NODE_ENV).toBe("development");
    expect(preview.server.env.MTLS_MODE).toBe("direct");
    expect(user.preview.credentialsRevision).toBe("");
    expect(preview.seed).toMatchObject({ enabled: true, mode: "demo" });
    expect(preview.global.nodeSelector).toEqual({
      "kubernetes.io/os": "linux",
      "kubernetes.io/arch": "amd64",
    });
    expect(preview.global.imagePullSecrets).toEqual([]);
    expect(preview.secrets.existingSecret).toBe("kq-preview-secrets");
    expect(preview.ingress).toMatchObject({ className: "traefik", tls: [] });
  });

  test("vendored Web nginx and unlock page stay identical to their shared sources", async () => {
    expect(await read(`${platform}/files/web-nginx.conf`)).toBe(
      await read("packages/web/nginx.conf"),
    );
    expect(await read(`${platform}/files/unlock.html`)).toBe(
      await read("deploy/preview/unlock.html"),
    );
    const helpers = await read(`${platform}/templates/_helpers.tpl`);
    expect(helpers).toContain('replace "http://server:3000"');
    expect(helpers).toContain('replace "http://registry:3100"');
    expect(helpers).toContain('replace "listen 80;"');
  });

  test("Basic unlock protects the cookie without replacing application Bearer auth", async () => {
    const gateway = await read(`${platform}/files/preview-nginx.conf.template`);
    const deployment = await read(`${platform}/templates/preview-gateway.yaml`);
    expect(gateway).toContain("map $cookie_kq_preview $preview_allowed");
    expect(gateway).toContain('~*^Basic "";');
    expect(gateway).toContain("location = /__preview/unlock");
    expect(gateway).toContain("auth_basic_user_file /etc/nginx/preview/htpasswd;");
    expect(gateway).toContain("alias /usr/share/nginx/html/unlock.html;");
    expect(gateway).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(gateway).toContain(`"\${PREVIEW_COOKIE}" 1;`);
    expect(gateway).toContain("proxy_set_header Authorization $preview_authorization;");
    expect(gateway).toContain("access_log off;");
    expect(gateway).toContain("error_log /dev/null crit;");
    expect(deployment).toContain('value: "^PREVIEW_COOKIE$"');
    expect(deployment).toContain("key: PREVIEW_COOKIE");
    expect(deployment).toContain("key: PREVIEW_HTPASSWD");
    expect(deployment).toContain(`[ "\${#PREVIEW_COOKIE}" -eq 64 ] || exit 1`);
    expect(deployment).not.toContain("key: PREVIEW_PASSWORD");
    expect(deployment).toContain(
      "kq.io/preview-credentials-revision: {{ .Values.preview.credentialsRevision | quote }}",
    );
  });

  test("S3 requires query signatures, not browser cookies, and preserves signed paths", async () => {
    const gateway = await read(`${platform}/files/preview-nginx.conf.template`);
    const bucket = gateway.slice(
      gateway.indexOf("location ^~ /{{ $bucket }}/"),
      gateway.indexOf("    {{- end }}"),
    );
    expect(bucket).not.toContain("$preview_allowed");
    expect(bucket).toContain("if ($preview_s3_signature_present = 0)");
    expect(bucket).toContain("if ($preview_s3_method_allowed = 0)");
    expect(bucket).toContain("return 403;");
    expect(bucket).toContain("return 405;");
    expect(bucket).toContain("limit_except GET PUT");
    expect(bucket).toContain("proxy_set_header Host $http_host;");
    expect(bucket).toContain('proxy_set_header Authorization "";');
    expect(bucket).toContain('proxy_set_header Cookie "";');
    expect(bucket).not.toContain("rewrite");
    expect(gateway).toContain("map $args $preview_s3_signature_present");
    expect(gateway).toContain('"~(^|&)X-Amz-Signature=[0-9a-fA-F]+(&|$)" 1;');
    expect(gateway).toContain("map $request_method $preview_s3_method_allowed");
    expect(gateway).toContain("    GET 1;");
    expect(gateway).toContain("    PUT 1;");
    expect(gateway).not.toContain("    HEAD 1;");
    expect(gateway).toContain("location = /{{ $bucket }} {\n        return 404;");
    expect(gateway).toContain("location = /{{ $bucket }}/ {\n        return 404;");
    expect(gateway).toContain("cp/agent-registration");
    expect(gateway).toContain("return 404;");
  });

  test("seed and scheduler wait in dependency order", async () => {
    const seed = await read(`${platform}/templates/seed-job.yaml`);
    const scheduler = await read(`${platform}/templates/scheduler.yaml`);
    const server = await read(`${platform}/templates/server-deployment.yaml`);
    expect(seed).toContain("name: wait-db-migration");
    expect(seed).toContain("name: SEED_MODE");
    expect(seed).toContain('include "kq.databaseEnv"');
    expect(seed).not.toContain("helm.sh/hook");
    const main = seed.slice(seed.indexOf("      containers:"));
    expect(main).not.toContain("command:");
    expect(scheduler).toContain("name: wait-seed");
    expect(server).toContain("name: wait-seed");
    expect(scheduler).toContain("test -d /workspace/node_modules/pino");
    expect(scheduler).toContain("value: slurm");
    expect(scheduler).toContain("value: host");
    expect(scheduler).not.toMatch(/hostPath:|hostNetwork:|docker\.sock|privileged: true/);
    expect(scheduler).toContain("claimName: {{ .Release.Name }}-agent");
    expect(scheduler).toContain('printf "https://%s-server:%v"');
    expect(scheduler).toContain("name: AGENT_MTLS_REQUIRED");
    expect(scheduler).toContain("name: KQ_AGENT_ENV_FILE");
  });

  test("direct mTLS separates Server PKI from registered Agent certificates", async () => {
    const server = await read(`${platform}/templates/server-deployment.yaml`);
    const scheduler = await read(`${platform}/templates/scheduler.yaml`);
    for (const key of ["SERVER_CA_CERT", "SERVER_CA_KEY", "SERVER_TLS_CERT", "SERVER_TLS_KEY"]) {
      expect(server).toContain(`key: ${key}`);
      expect(scheduler).not.toContain(`key: ${key}`);
    }
    expect(server).toContain("value: /etc/kuintessence/ca");
    expect(server).toContain("value: /etc/kuintessence/tls/server.crt");
    expect(server).toContain("value: /etc/kuintessence/tls/server.key");
    expect(scheduler).toContain("scheduler.registration.existingSecret");
    expect(scheduler).toContain("name: KQ_AGENT_REGISTRATION_ENABLED");
    expect(scheduler).toContain('value: "0"');
    for (const key of ["client.crt", "client.key", "ca.crt"]) {
      expect(scheduler).toContain(`key: ${key}`);
    }
    expect(server).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(scheduler).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });
});
