import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const IMPORT = "/software/api/spack/recipe-repositories/import";
const configurations = [
  { file: "packages/web/nginx.conf", upstream: "http://registry:3100", preview: false },
  { file: "deploy/aio/nginx.conf", upstream: "http://127.0.0.1:3100", preview: false },
  { file: "deploy/preview/nginx.conf.template", upstream: "http://web:80", preview: true },
];

// These static checks do not start nginx or resolve container hostnames.
function block(source: string, declaration: string): string | undefined {
  const start = source.indexOf(`${declaration} {`);
  if (start < 0) return undefined;
  const open = source.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unclosed nginx block: ${declaration}`);
}

function directive(source: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}\\s+([^;]+);`, "m").exec(source)?.[1]?.trim();
}

describe("recipe upload nginx configuration (offline)", () => {
  for (const { file, upstream, preview } of configurations) {
    test(`${file} accepts a 128 MiB raw import with bounded upstream wait and streaming`, async () => {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const upload = block(source, `location = ${IMPORT}`);
      expect(upload).toBeDefined();
      if (!upload) throw new Error("Missing exact recipe upload location");
      expect(directive(upload, "client_max_body_size")).toBe("128m");
      expect(directive(upload, "proxy_request_buffering")).toBe("off");
      expect(directive(upload, "proxy_read_timeout")).toBe("900s");
      expect(directive(upload, "proxy_send_timeout")).toBe("900s");
      expect(directive(upload, "proxy_http_version")).toBe("1.1");
      expect(directive(upload, "proxy_pass")).toBe(upstream);
      expect(directive(upload, "proxy_set_header Authorization")).toBe(
        preview ? "$preview_authorization" : "$registry_authorization",
      );
      if (!preview) {
        expect(directive(upload, "rewrite")).toBe("^/software/(.*)$ /$1 break");
        const auth = block(source, "map $http_authorization $registry_authorization");
        expect(auth).toBeDefined();
        expect(directive(auth ?? "", "default")).toBe("$http_authorization");
        expect(auth).toContain('"" "Bearer $cookie_kq_access_token";');
      }
    });

    test(`${file} retains the limits and routing of unrelated paths`, async () => {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const server = block(source, "server");
      expect(server).toBeDefined();
      const serverDirectives = server?.split(/\blocation\b/)[0] ?? "";
      expect(directive(serverDirectives, "client_max_body_size")).toBe(preview ? "32m" : undefined);
      expect(directive(serverDirectives, "proxy_read_timeout")).toBeUndefined();
      const paths = preview
        ? ["/", "= /__preview/unlock"]
        : ["/software/api/", "/platform/api/", "/api/", "/v2/", "/buildcache/"];
      for (const path of paths) {
        const location = block(source, `location ${path}`);
        expect(location).toBeDefined();
        expect(directive(location ?? "", "client_max_body_size")).toBeUndefined();
        expect(directive(location ?? "", "proxy_request_buffering")).toBeUndefined();
        expect(directive(location ?? "", "proxy_read_timeout")).toBe(
          preview && path === "/" ? "65s" : undefined,
        );
      }
    });
  }

  test("preview imports retain the access gate and strip Basic auth before forwarding", async () => {
    const source = await readFile(
      new URL("../deploy/preview/nginx.conf.template", import.meta.url),
      "utf8",
    );
    const upload = block(source, `location = ${IMPORT}`) ?? "";
    const gate = block(upload, "if ($preview_allowed = 0)");
    expect(gate).toBeDefined();
    expect(directive(gate ?? "", "return")).toBe("302 /__preview/unlock");
    expect(directive(upload, "proxy_hide_header")).toBe("Cache-Control");
    expect(directive(upload, "proxy_set_header X-Forwarded-Proto")).toBe("https");
    const auth = block(source, "map $http_authorization $preview_authorization");
    expect(auth).toContain('~*^Basic "";');
    const unlock = block(source, "location = /__preview/unlock") ?? "";
    expect(directive(unlock, "auth_basic")).toBe('"Kuintessence preview"');
    expect(directive(unlock, "auth_basic_user_file")).toBe("/etc/nginx/preview.htpasswd");
  });
});
