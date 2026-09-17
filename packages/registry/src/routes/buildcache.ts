// Spack buildcache HTTP layer for the Registry.
//
// Spack expects a buildcache "mirror" to expose three things over HTTP:
//
//   - /<root>/index.json                                  (the spec index)
//   - /<root>/build_cache/<package>-<hash>.spec.json      (per-spec JSON)
//   - /<root>/build_cache/<package>-<hash>.spack          (binary tarball)
//
// `<root>` here is the namespace prefix `<kind>/[<owner>/]<repo>` so the
// same RBAC matrix as the OCI router applies. Writes are required only
// for org-internal mirrors; the public namespace is served read-only to
// any authenticated user but can be uploaded to by platform admins.

import { type Context, Hono } from "hono";
import { ociErrorJson, type RegistryEnv } from "../middleware/principal";
import {
  checkNamespaceAccess,
  DEFAULT_PUBLISHER_ROLES,
  NamespaceParseError,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
  type RegistryRole,
} from "../services/namespace";
import { RegistryError, type RegistryService } from "../services/registry-service";

interface CreateBuildcacheRoutesOptions {
  service: RegistryService;
  publisherRoles?: RegistryRole[];
}

const SPACK_FILENAME_RE = /^([A-Za-z0-9._+-]+)-([0-9a-z]{32,64})\.(spec\.json|spack)$/;

export function createBuildcacheRoutes(opts: CreateBuildcacheRoutesOptions): Hono<RegistryEnv> {
  const { service } = opts;
  const publisherRoles = opts.publisherRoles ?? DEFAULT_PUBLISHER_ROLES;
  const r = new Hono<RegistryEnv>();

  // The path under /buildcache always starts with the namespace prefix.
  // We greedy-match the namespace + repo via :rest{.+} and split on
  // `/build_cache/` or `/index.json` afterwards.

  r.get("/:rest{.+}/index.json", async (c) => {
    try {
      const principal = readPrincipal(c);
      const ns = parseNamespace(c.req.param("rest") ?? "");
      checkNamespaceAccess(principal, ns, "read", publisherRoles);
      const entries = await service.listSpackIndex(ns);
      return c.json({
        version: 1,
        namespace: c.req.param("rest"),
        entries,
      });
    } catch (e) {
      return mapError(c, e);
    }
  });

  r.get("/:rest{.+}/build_cache/:filename", async (c) => {
    try {
      const principal = readPrincipal(c);
      const ns = parseNamespace(c.req.param("rest") ?? "");
      checkNamespaceAccess(principal, ns, "read", publisherRoles);
      const file = c.req.param("filename") ?? "";
      const parsed = parseSpackFilename(file);
      const r2 = await service.getSpackArtifact({
        ns,
        package: parsed.pkg,
        hash: parsed.hash,
        kind: parsed.kind,
      });
      c.header("Content-Type", r2.contentType);
      c.header("Content-Length", String(r2.size));
      return new Response(r2.stream, { status: 200, headers: c.res.headers });
    } catch (e) {
      return mapError(c, e);
    }
  });

  r.put("/:rest{.+}/build_cache/:filename", async (c) => {
    try {
      const principal = readPrincipal(c);
      const ns = parseNamespace(c.req.param("rest") ?? "");
      checkNamespaceAccess(principal, ns, "write", publisherRoles);
      const file = c.req.param("filename") ?? "";
      const parsed = parseSpackFilename(file);
      if (parsed.kind !== "tarball") {
        return ociErrorJson(
          c,
          400,
          "MANIFEST_INVALID",
          "PUT only supports the .spack binary; spec.json is regenerated server-side",
        );
      }
      const arch = c.req.query("arch") ?? "linux-x86_64";
      const spec = c.req.query("spec") ?? `${parsed.pkg}@unknown`;
      const body = new Uint8Array(await c.req.arrayBuffer());
      const entry = await service.putSpackArtifact({
        ns,
        package: parsed.pkg,
        hash: parsed.hash,
        arch,
        spec,
        body,
        principal,
      });
      return c.json(entry, 201);
    } catch (e) {
      return mapError(c, e);
    }
  });

  r.delete("/:rest{.+}/build_cache/:filename", async (c) => {
    try {
      const principal = readPrincipal(c);
      const ns = parseNamespace(c.req.param("rest") ?? "");
      checkNamespaceAccess(principal, ns, "write", publisherRoles);
      const parsed = parseSpackFilename(c.req.param("filename") ?? "");
      await service.deleteSpackArtifact({
        ns,
        package: parsed.pkg,
        hash: parsed.hash,
        principal,
      });
      return c.body(null, 204);
    } catch (e) {
      return mapError(c, e);
    }
  });

  return r;
}

type BcContext = Context<RegistryEnv>;

function readPrincipal(c: BcContext): RbacPrincipal {
  return c.get("principal");
}

interface ParsedSpackFilename {
  pkg: string;
  hash: string;
  kind: "spec" | "tarball";
}

function parseSpackFilename(file: string): ParsedSpackFilename {
  const m = SPACK_FILENAME_RE.exec(file);
  if (!m) {
    throw new RegistryError(
      "MANIFEST_INVALID",
      `'${file}' is not a Spack buildcache filename (<pkg>-<hash>.spec.json|.spack)`,
    );
  }
  const [, pkg, hash, ext] = m;
  if (!pkg || !hash || !ext) {
    throw new RegistryError("MANIFEST_INVALID", `'${file}' missing parts`);
  }
  return { pkg, hash, kind: ext === "spec.json" ? "spec" : "tarball" };
}

function mapError(c: BcContext, err: unknown) {
  if (err instanceof NamespaceParseError) {
    return ociErrorJson(c, 400, "NAME_INVALID", err.message);
  }
  if (err instanceof NamespacePermissionError) {
    return ociErrorJson(c, 403, "DENIED", err.message);
  }
  if (err instanceof RegistryError) {
    return ociErrorJson(
      c,
      err.status as 400 | 401 | 403 | 404 | 409,
      err.code,
      err.message,
      err.detail,
    );
  }
  throw err;
}
