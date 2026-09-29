import { describe, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const enabled = process.env.KQ_RUN_CONTAINER_CONTRACTS === "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const release = "kq-pr-17";
const host = `${release}.preview.example.test`;
// Public, fixed fixtures only. Never read deployment credentials or material.
const cookie = "0123456789abcdef".repeat(4);
const password = "gateway-fixture-password";
const basic = `Basic ${Buffer.from(`preview:${password}`).toString("base64")}`;
const bearer = "Bearer gateway-fixture-bearer";
const signature = "ab".repeat(32);
const buckets = ["fixture-files", "fixture-staging", "fixture-immutable"];

type Stage =
  | "guard"
  | "render"
  | "fixtures"
  | "image"
  | "legacy"
  | "syntax"
  | "network"
  | "mock"
  | "gateway"
  | "publish"
  | "entrypoint"
  | "envsubst"
  | "auth"
  | "routes"
  | "leakage"
  | "cleanup";

interface Gateway {
  image: string;
  command: string[];
  args: string[];
  env: { name: string; value?: string }[];
  ports: { name: string; containerPort: number }[];
}

interface Resource {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: { template?: { spec: { containers: Gateway[] } } };
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface UpstreamResponse {
  authorization: string;
  cookie: string;
  host: string;
  uri: string;
  method: string;
}

function mockConfig() {
  const response =
    '{"authorization":"$http_authorization","cookie":"$http_cookie",' +
    '"host":"$http_host","uri":"$request_uri","method":"$request_method"}';
  return `
events {}
http {
  access_log off;
  error_log /dev/null crit;
  add_header X-Fixture-Upstream true always;
  server {
    listen 80;
    location / {
      default_type application/json;
      return 200 '${response}';
    }
  }
  server {
    listen 9000;
    location / {
      default_type application/json;
      return 403 '${response}';
    }
  }
}
`;
}

describe.skipIf(!enabled)("Helm gateway nginx container contract (Actions only)", () => {
  test("boots the rendered gateway and enforces authentication boundaries", async () => {
    let stage: Stage = "guard";
    let directory = "";
    let network = "";
    let gatewayName = "";
    const containers: string[] = [];
    const captured: string[] = [];
    const check = (condition: unknown, code: string): void => {
      if (!condition) throw new Error(`GATEWAY_CONTRACT stage=${stage} code=${code}`);
    };
    const complete = () => console.log(`GATEWAY_CONTRACT stage=${stage} status=ok`);
    const command = async (args: string[], allowFailure = false): Promise<Result> => {
      try {
        const child = Bun.spawn({
          cmd: args,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill(), 120_000);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          if (!allowFailure) check(code === 0, "COMMAND_FAILED");
          return { code, stdout, stderr };
        } finally {
          clearTimeout(timer);
        }
      } catch {
        throw new Error(`GATEWAY_CONTRACT stage=${stage} code=COMMAND_FAILED`);
      }
    };
    try {
      check(process.env.GITHUB_ACTIONS === "true", "ACTIONS_REQUIRED");
      check(process.platform === "linux", "LINUX_REQUIRED");
      check(process.arch === "x64", "AMD64_REQUIRED");
      check(Bun.which("helm") && Bun.which("docker"), "TOOLS_REQUIRED");
      complete();
      directory = await mkdtemp(join(tmpdir(), "kq-gateway-"));
      const prefix = `kq-gateway-${process.pid}-${Date.now()}`;
      const chart = join(directory, "kq-preview");
      stage = "render";
      await cp(join(root, "deploy/helm/kq-platform"), join(directory, "kq-platform"), {
        recursive: true,
      });
      await cp(join(root, "deploy/helm/kq-preview"), chart, { recursive: true });
      await command(["helm", "dependency", "build", chart, "--skip-refresh"]);
      const settings = [
        `preview.host=${host}`,
        "preview.repository=example/project",
        `secrets.existingSecret=${release}-secrets`,
        `netdrive.bucket=${buckets[0]}`,
        `netdrive.dataMarketStagingBucket=${buckets[1]}`,
        `netdrive.dataMarketImmutableBucket=${buckets[2]}`,
        ...["server", "registry", "web", "migration", "scheduler", "seed"].flatMap((key) => [
          `${key}.image.repository=example/fixture-${key}`,
          `${key}.image.tag=fixture`,
        ]),
      ];
      const rendered = await command([
        "helm",
        "template",
        release,
        chart,
        "--namespace",
        "preview",
        ...settings.flatMap((setting) => ["--set-string", `kq-platform.${setting}`]),
      ]);
      const resources = parseAllDocuments(rendered.stdout).map((document) => {
        check(document.errors.length === 0, "INVALID_YAML");
        return document.toJS() as Resource | null;
      });
      const config = resources.find(
        (item) => item?.kind === "ConfigMap" && item.metadata.name === `${release}-preview-gateway`,
      )?.data;
      const gateway = resources.find(
        (item) => item?.kind === "Deployment" && item.metadata.name === `${release}-gateway`,
      )?.spec?.template?.spec.containers[0];
      if (!config || !gateway) throw new Error("GATEWAY_CONTRACT stage=render code=MISSING");
      const template = config["default.conf.template"];
      const unlock = config["unlock.html"];
      if (!template || !unlock) throw new Error("GATEWAY_CONTRACT stage=render code=MISSING");
      check(!template.includes(cookie), "COOKIE_IN_CONFIGMAP");
      check(template.includes("map_hash_bucket_size 128;"), "HASH_BUCKET_MISSING");
      const entrypoint = gateway.command[0];
      if (entrypoint !== "/bin/sh") {
        throw new Error("GATEWAY_CONTRACT stage=render code=ENTRYPOINT_CHANGED");
      }
      const filter = gateway.env.find((item) => item.name === "NGINX_ENVSUBST_FILTER")?.value;
      check(filter === "^PREVIEW_COOKIE$", "UNSAFE_ENVSUBST");
      const port = gateway.ports.find((item) => item.name === "http")?.containerPort;
      check(port === 8080, "PORT_CHANGED");
      complete();

      stage = "fixtures";
      const templates = join(directory, "templates");
      const legacy = join(directory, "legacy");
      const auth = join(directory, "auth");
      for (const path of [templates, legacy, auth]) await mkdir(path, { mode: 0o755 });
      await writeFile(join(templates, "default.conf.template"), template, { mode: 0o444 });
      await writeFile(
        join(legacy, "default.conf.template"),
        template.replace("map_hash_bucket_size 128;", "map_hash_bucket_size 64;"),
        { mode: 0o444 },
      );
      await writeFile(join(directory, "unlock.html"), unlock, { mode: 0o444 });
      const hash = createHash("sha1").update(password).digest("base64");
      await writeFile(join(auth, "htpasswd"), `preview:{SHA}${hash}\n`, { mode: 0o444 });
      await writeFile(join(directory, "mock.conf"), mockConfig(), { mode: 0o444 });
      const mounts = (source: string) => [
        "--volume",
        `${source}:/etc/nginx/templates:ro`,
        "--volume",
        `${auth}:/etc/nginx/preview:ro`,
        "--volume",
        `${join(directory, "unlock.html")}:/usr/share/nginx/html/unlock.html:ro`,
      ];
      const environment = (value = cookie) => [
        "--env",
        `PREVIEW_COOKIE=${value}`,
        "--env",
        `NGINX_ENVSUBST_FILTER=${filter}`,
      ];
      const hosts = [
        "--add-host",
        `${release}-web:127.0.0.1`,
        "--add-host",
        `${release}-rustfs:127.0.0.1`,
      ];
      complete();
      stage = "image";
      await command(["docker", "pull", gateway.image]);
      complete();

      // Reproduce the deployed 64-byte bucket setting explicitly.
      for (const [name, source] of [
        ["legacy", legacy],
        ["syntax", templates],
      ] as const) {
        stage = name;
        const container = `${prefix}-${name}`;
        containers.push(container);
        const result = await command(
          [
            "docker",
            "run",
            "--name",
            container,
            "--network",
            "none",
            ...hosts,
            ...mounts(source),
            ...environment(),
            gateway.image,
            "nginx",
            "-t",
          ],
          true,
        );
        captured.push(result.stdout, result.stderr);
        if (name === "legacy") {
          check(result.code !== 0, "LEGACY_UNEXPECTEDLY_ACCEPTED");
          check(result.stderr.includes("could not build map_hash"), "LEGACY_WRONG_FAILURE");
        } else {
          check(result.code === 0, "NGINX_CONFIG_REJECTED");
        }
        complete();
      }

      stage = "network";
      network = `${prefix}-network`;
      // Dedicated fixture bridge; only the gateway is published, on loopback.
      await command(["docker", "network", "create", "--driver", "bridge", network]);
      complete();
      stage = "mock";
      const mockName = `${prefix}-upstream`;
      containers.push(mockName);
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        mockName,
        "--network",
        network,
        "--network-alias",
        `${release}-web`,
        "--network-alias",
        `${release}-rustfs`,
        "--volume",
        `${join(directory, "mock.conf")}:/etc/nginx/nginx.conf:ro`,
        gateway.image,
      ]);
      complete();
      stage = "gateway";
      gatewayName = `${prefix}-gateway`;
      containers.push(gatewayName);
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        gatewayName,
        "--network",
        network,
        "--publish",
        "127.0.0.1::8080",
        ...mounts(templates),
        ...environment(),
        "--entrypoint",
        entrypoint,
        gateway.image,
        ...gateway.command.slice(1),
        ...gateway.args,
      ]);
      complete();
      stage = "publish";
      const published = await command(["docker", "port", gatewayName, "8080/tcp"]);
      const address = published.stdout.trim();
      check(/^127\.0\.0\.1:[0-9]+$/.test(address), "NONLOCAL_PORT");
      complete();
      stage = "entrypoint";
      const request = async (path: string, options: RequestInit = {}) => {
        try {
          const headers = new Headers(options.headers);
          if (!headers.has("Host")) headers.set("Host", host);
          return await fetch(`http://${address}${path}`, {
            ...options,
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          throw new Error(`GATEWAY_CONTRACT stage=${stage} code=HTTP_FAILED`);
        }
      };
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await request("/");
          await response.arrayBuffer();
          const upstream = await request("/", {
            headers: { Cookie: `kq_preview=${cookie}` },
          });
          await upstream.arrayBuffer();
          ready = response.status === 302 && upstream.status === 200;
        } catch {
          // Startup retry only; assertions below never retry an auth failure.
        }
        if (ready) break;
        await Bun.sleep(500);
      }
      check(ready, "STARTUP_FAILED");
      complete();

      stage = "envsubst";
      const generated = await command([
        "docker",
        "exec",
        gatewayName,
        "cat",
        "/etc/nginx/conf.d/default.conf",
      ]);
      check(generated.stdout === template.replaceAll(`\${PREVIEW_COOKIE}`, cookie), "BAD_SUBST");
      const syntax = await command(["docker", "exec", gatewayName, "nginx", "-t"]);
      captured.push(syntax.stdout, syntax.stderr);
      complete();

      stage = "auth";
      for (const authorization of ["", "Basic invalid-fixture", bearer]) {
        const response = await request("/__preview/unlock", {
          headers: { Authorization: authorization },
        });
        check(response.status === 401, "UNLOCK_WITHOUT_BASIC");
        check(!response.headers.has("set-cookie"), "UNAUTHORIZED_COOKIE");
        check(!(await response.text()).includes(cookie), "UNAUTHORIZED_BODY");
      }
      const unlocked = await request("/__preview/unlock", {
        headers: { Authorization: basic },
      });
      check(unlocked.status === 200, "BASIC_REJECTED");
      check(
        unlocked.headers.get("set-cookie") ===
          `kq_preview=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
        "COOKIE_ATTRIBUTES",
      );
      const unlockBody = await unlocked.text();
      check(!unlockBody.includes(cookie) && !unlockBody.includes(password), "UNLOCK_BODY");
      const unauthenticated: Record<string, string>[] = [
        {},
        { Authorization: bearer },
        { Cookie: "kq_preview=invalid-fixture" },
        { Authorization: basic },
      ];
      for (const headers of unauthenticated) {
        const response = await request("/platform/api/health", { headers });
        check(response.status === 302, "COOKIE_GATE_BYPASSED");
        check(response.headers.get("location") === "/__preview/unlock", "BAD_REDIRECT");
        check(!response.headers.has("set-cookie"), "REDIRECT_COOKIE");
        await response.arrayBuffer();
      }
      complete();

      stage = "routes";
      for (const path of [
        "/",
        "/platform/api/health",
        "/software/api/spack/recipe-repositories/import",
        "/software/api/spack/upstream-imports",
        "/software/api/spack/material-repositories/fixture",
      ]) {
        for (const authorization of [basic, bearer]) {
          const response = await request(path, {
            headers: { Cookie: `kq_preview=${cookie}`, Authorization: authorization },
          });
          check(response.status === 200, "WEB_ROUTE_FAILED");
          const observed = (await response.json()) as UpstreamResponse;
          check(
            observed.authorization === (authorization === basic ? "" : bearer),
            "UPSTREAM_AUTH_LEAK",
          );
          check(observed.host === host && observed.uri === path, "WEB_REWRITE");
        }
      }
      for (const path of [
        "/api/cp/agent-registration",
        "/platform/api/cp/agent-registration-tokens",
        "/api/agent-registration",
        "/platform/api/admin/agents",
      ]) {
        const response = await request(path, { headers: { Cookie: `kq_preview=${cookie}` } });
        check(response.status === 404, "REGISTRATION_PUBLIC");
        await response.arrayBuffer();
      }
      for (const bucket of buckets) {
        for (const path of [`/${bucket}`, `/${bucket}/`]) {
          const response = await request(`${path}?X-Amz-Signature=${signature}`);
          check(response.status === 404, "BUCKET_ROOT_PUBLIC");
          await response.arrayBuffer();
        }
        const missing = await request(`/${bucket}/fixture`);
        check(missing.status === 403, "UNSIGNED_OBJECT_PUBLIC");
        await missing.arrayBuffer();
        const path = `/${bucket}/fixture%20object?X-Amz-Signature=${signature}&fixture=1`;
        for (const method of ["GET", "PUT"]) {
          const storageHeaders: Record<string, string>[] = [
            { Host: `${host}:443` },
            {
              Host: `${host}:443`,
              Authorization: bearer,
              Cookie: `kq_preview=${cookie}`,
            },
          ];
          for (const headers of storageHeaders) {
            const response = await request(path, { method, headers });
            // The mock rejects signatures; the gateway must not authorize them itself.
            check(response.status === 403, "STORAGE_AUTH_BYPASSED");
            check(
              response.headers.get("x-fixture-upstream") === "true",
              "STORAGE_UPSTREAM_MISSING",
            );
            const observed = (await response.json()) as UpstreamResponse;
            check(observed.authorization === "" && observed.cookie === "", "STORAGE_AUTH_LEAK");
            check(observed.uri === path && observed.host === `${host}:443`, "SIGNED_REWRITE");
            check(observed.method === method, "SIGNED_METHOD_CHANGED");
          }
        }
        const denied = await request(path, { method: "POST" });
        check(denied.status === 403 || denied.status === 405, "UNSAFE_STORAGE_METHOD");
        check(!denied.headers.has("x-fixture-upstream"), "UNSAFE_STORAGE_UPSTREAM_HEADER");
        const deniedBody = await denied.text();
        check(!deniedBody.includes('"authorization":'), "UNSAFE_STORAGE_UPSTREAM_BODY");
      }
      complete();

      stage = "leakage";
      for (const container of [gatewayName, mockName]) {
        const logs = await command(["docker", "logs", container]);
        captured.push(logs.stdout, logs.stderr);
      }
      const logs = captured.join("\n");
      for (const forbidden of [cookie, password, basic, bearer, signature, "X-Amz-Signature"]) {
        check(!logs.includes(forbidden), "SENSITIVE_LOG");
      }
      const unchanged = await readFile(join(templates, "default.conf.template"), "utf8");
      check(unchanged === template, "MUTATED");
      complete();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safe = /^GATEWAY_CONTRACT stage=[a-z]+ code=[A-Z_]+$/;
      throw new Error(safe.test(message) ? message : `GATEWAY_CONTRACT stage=${stage} code=FAILED`);
    } finally {
      stage = "cleanup";
      let cleaned = true;
      for (const container of containers.reverse()) {
        try {
          const result = await command(["docker", "rm", "-f", container], true);
          cleaned = (result.code === 0 || result.stderr.includes("No such container")) && cleaned;
        } catch {
          cleaned = false;
        }
      }
      if (network) {
        try {
          const result = await command(["docker", "network", "rm", network], true);
          cleaned = (result.code === 0 || result.stderr.includes("not found")) && cleaned;
        } catch {
          cleaned = false;
        }
      }
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          cleaned = false;
        }
      }
      check(cleaned, "INCOMPLETE");
      complete();
    }
  }, 600_000);
});
