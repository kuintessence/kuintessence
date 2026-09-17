// Docker Distribution v2 subset for the Registry.
//
// The router lives at /v2 and implements the bare minimum needed for
// `docker push`, `docker pull`, `apptainer pull`, and OCI conformance
// scans:
//
//   GET    /v2/                                          — version probe
//   GET    /v2/_catalog                                  — repo listing
//   HEAD   /v2/<name>/blobs/<digest>                     — blob exists?
//   GET    /v2/<name>/blobs/<digest>                     — blob fetch
//   POST   /v2/<name>/blobs/uploads/                     — start upload
//   PATCH  /v2/<name>/blobs/uploads/<uuid>               — chunk upload
//   PUT    /v2/<name>/blobs/uploads/<uuid>?digest=…      — finalize
//   DELETE /v2/<name>/blobs/uploads/<uuid>               — abort
//   HEAD   /v2/<name>/manifests/<ref>                    — manifest exists
//   GET    /v2/<name>/manifests/<ref>                    — manifest body
//   PUT    /v2/<name>/manifests/<ref>                    — push manifest/tag
//   DELETE /v2/<name>/manifests/<ref>                    — delete tag
//   GET    /v2/<name>/tags/list                          — list tags
//
// Errors follow the Distribution spec envelope:
//   { errors: [ { code, message, detail? } ] }
//
// All non-version paths run principal extraction + namespace parsing +
// RBAC check. The /<name> segment must match `<kind>/[<owner>/]<repo>`
// per `parseNamespace`.

import { type Context, Hono } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import { z } from "zod";
import { ociErrorJson, type RegistryEnv } from "../middleware/principal";
import {
  checkNamespaceAccess,
  DEFAULT_PUBLISHER_ROLES,
  NamespaceParseError,
  NamespacePermissionError,
  type Operation,
  parseNamespace,
  type RbacPrincipal,
  type RegistryRole,
} from "../services/namespace";
import { RegistryError, type RegistryService } from "../services/registry-service";

interface CreateOciRoutesOptions {
  service: RegistryService;
  publisherRoles?: RegistryRole[];
}

const SHA_RE = /^sha256:[0-9a-f]{64}$/;

// Distribution v2 §6.5.2 cross-repo mount params. The `mount` query is the
// blob digest, `from` is the source repo path. Both are validated before we
// touch the service layer.
const mountQuerySchema = z.object({
  mount: z.string().regex(SHA_RE, "mount digest must match sha256:<hex>").optional(),
  from: z.string().min(1, "from must be a non-empty repo path").optional(),
});

// Pagination params: `n` is a positive integer, `last` is a free-form cursor
// echoed back from the previous page. Empty/zero values resolve to defaults.
const paginationQuerySchema = z.object({
  n: z
    .string()
    .regex(/^\d+$/, "n must be a non-negative integer")
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional(),
  last: z.string().min(1).optional(),
});

type OciContext = Context<RegistryEnv>;

function ociError(c: OciContext, err: unknown) {
  if (err instanceof NamespaceParseError) {
    return ociErrorJson(c, 400, "NAME_INVALID", err.message);
  }
  if (err instanceof NamespacePermissionError) {
    return ociErrorJson(c, 403, "DENIED", err.message);
  }
  if (err instanceof RegistryError) {
    return ociErrorJson(
      c,
      err.status as 400 | 401 | 403 | 404 | 409 | 413,
      err.code,
      err.message,
      err.detail,
    );
  }
  // Unknown — bubble up to the surrounding handler if any.
  throw err;
}

function readPrincipal(c: OciContext): RbacPrincipal {
  return c.get("principal");
}

function authorize(
  principal: RbacPrincipal,
  namePath: string,
  op: Operation,
  publisherRoles: RegistryRole[],
): { ns: ReturnType<typeof parseNamespace> } {
  const ns = parseNamespace(namePath);
  checkNamespaceAccess(principal, ns, op, publisherRoles);
  return { ns };
}

export function createOciRoutes(options: CreateOciRoutesOptions): Hono<RegistryEnv> {
  const { service } = options;
  const publisherRoles = options.publisherRoles ?? DEFAULT_PUBLISHER_ROLES;
  // Hono's default RegExpRouter trips on the OCI patterns once both
  // `/:rest{.+}/blobs/uploads/` and `/:rest{.+}/blobs/:digest` are
  // registered alongside `/_catalog`: 4-segment names like
  // `/org/<orgId>/<repo>/blobs/uploads/` fall through to a 404. The
  // PatternRouter resolves these correctly because it builds one URL
  // regex per route instead of fusing them into a shared automaton.
  const r = new Hono<RegistryEnv>({ router: new PatternRouter() });

  // Version probe — Docker Distribution requires this header even on
  // unauthenticated hits, but the integrator chose to gate it behind
  // the principal middleware to discourage anonymous registry probes.
  // Match both /v2 and /v2/ so curl + docker clients agree.
  const versionProbe = (c: OciContext) => {
    c.header("Docker-Distribution-API-Version", "registry/2.0");
    return c.json({});
  };
  r.get("/", versionProbe);
  r.get("", versionProbe);

  r.get("/_catalog", async (c) => {
    try {
      const principal = readPrincipal(c);
      const parsed = paginationQuerySchema.safeParse({
        n: c.req.query("n"),
        last: c.req.query("last"),
      });
      if (!parsed.success) {
        return ociErrorJson(c, 400, "PAGINATION_INVALID", parsed.error.message);
      }
      const { n, last } = parsed.data;
      const page = await service.listRepositories({
        n,
        last,
        canRead: (kind, owner) => {
          try {
            checkNamespaceAccess(principal, { kind, owner, name: "_listing" }, "read");
            return true;
          } catch {
            return false;
          }
        },
      });
      if (page.hasMore && page.repositories.length > 0) {
        const lastItem = page.repositories[page.repositories.length - 1];
        if (lastItem !== undefined) {
          c.header("Link", catalogLinkHeader(n, lastItem));
        }
      }
      return c.json({ repositories: page.repositories });
    } catch (e) {
      return ociError(c, e);
    }
  });

  // Blob upload start — POST /v2/<name>/blobs/uploads/
  r.post("/:rest{.+}/blobs/uploads", async (c) => {
    return handleStartUpload(c, service, publisherRoles);
  });
  // Some clients hit the trailing slash explicitly: /v2/<name>/blobs/uploads/
  r.post("/:rest{.+}/blobs/uploads/", async (c) => {
    return handleStartUpload(c, service, publisherRoles);
  });

  r.patch("/:rest{.+}/blobs/uploads/:uuid", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "write", publisherRoles);
      void ns;
      const uploadId = c.req.param("uuid");
      const body = readBodyStream(c);
      const r2 = await service.appendChunk(uploadId, body);
      c.header("Location", `/v2/${c.req.param("rest")}/blobs/uploads/${uploadId}`);
      c.header("Range", `0-${Math.max(r2.totalUploaded - 1, 0)}`);
      c.header("Docker-Upload-UUID", uploadId);
      return c.body(null, 202);
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.put("/:rest{.+}/blobs/uploads/:uuid", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "write", publisherRoles);
      void ns;
      const uploadId = c.req.param("uuid");
      const digest = c.req.query("digest");
      if (!digest || !SHA_RE.test(digest)) {
        return ociErrorJson(
          c,
          400,
          "DIGEST_INVALID",
          `query digest is required and must match sha256:<hex>`,
        );
      }
      const body = readBodyStream(c);
      const r2 = await service.completeUpload(uploadId, digest, body);
      c.header("Location", `/v2/${c.req.param("rest")}/blobs/${r2.digest}`);
      c.header("Docker-Content-Digest", r2.digest);
      return c.body(null, 201);
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.delete("/:rest{.+}/blobs/uploads/:uuid", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "write", publisherRoles);
      void ns;
      await service.cancelUpload(c.req.param("uuid"));
      return c.body(null, 204);
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.on(["HEAD", "GET"], "/:rest{.+}/blobs/:digest", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "read", publisherRoles);
      const repo = await service.findRepository(ns);
      if (!repo) {
        return ociErrorJson(c, 404, "NAME_UNKNOWN", `repository ${c.req.param("rest")} not found`);
      }
      const digest = c.req.param("digest");
      if (!digest || !SHA_RE.test(digest)) {
        return ociErrorJson(c, 400, "DIGEST_INVALID", `digest must match sha256:<hex>`);
      }
      if (c.req.method === "HEAD") {
        const stat = await service.headBlob(repo.id, digest);
        c.header("Docker-Content-Digest", digest);
        c.header("Content-Length", String(stat.size));
        return c.body(null, 200);
      }
      const { stream, size } = await service.getBlob(repo.id, digest);
      c.header("Docker-Content-Digest", digest);
      c.header("Content-Length", String(size));
      c.header("Content-Type", "application/octet-stream");
      return new Response(stream, { status: 200, headers: c.res.headers });
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.put("/:rest{.+}/manifests/:ref", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "write", publisherRoles);
      const repo = await service.ensureRepository(ns, principal);
      const mediaType =
        c.req.header("Content-Type") ?? "application/vnd.oci.image.manifest.v1+json";
      const body = await readBodyBytes(c);
      const ref = c.req.param("ref") ?? "";
      const r2 = await service.putManifest({ repo, ref, mediaType, body, principal });
      c.header("Location", `/v2/${c.req.param("rest")}/manifests/${ref}`);
      c.header("Docker-Content-Digest", r2.digest);
      return c.body(null, 201);
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.on(["HEAD", "GET"], "/:rest{.+}/manifests/:ref", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "read", publisherRoles);
      const repo = await service.findRepository(ns);
      if (!repo) {
        return ociErrorJson(c, 404, "NAME_UNKNOWN", `repository ${c.req.param("rest")} not found`);
      }
      const ref = c.req.param("ref") ?? "";
      const m = await service.getManifestByRef(repo.id, ref);
      c.header("Docker-Content-Digest", m.digest);
      c.header("Content-Type", m.mediaType);
      c.header("Content-Length", String(m.body.byteLength));
      if (c.req.method === "HEAD") {
        return c.body(null, 200);
      }
      // ArrayBufferView is accepted by Response; we hand back a fresh Response
      // to keep header bookkeeping consistent with the streaming blob path.
      return new Response(m.body, { status: 200, headers: c.res.headers });
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.delete("/:rest{.+}/manifests/:ref", async (c) => {
    try {
      const principal = readPrincipal(c);
      const { ns } = authorize(principal, c.req.param("rest") ?? "", "write", publisherRoles);
      const repo = await service.findRepository(ns);
      if (!repo) {
        return ociErrorJson(c, 404, "NAME_UNKNOWN", `repository ${c.req.param("rest")} not found`);
      }
      await service.deleteManifest({ repo, ref: c.req.param("ref") ?? "", principal });
      return c.body(null, 202);
    } catch (e) {
      return ociError(c, e);
    }
  });

  r.get("/:rest{.+}/tags/list", async (c) => {
    try {
      const principal = readPrincipal(c);
      const rest = c.req.param("rest") ?? "";
      const { ns } = authorize(principal, rest, "read", publisherRoles);
      const repo = await service.findRepository(ns);
      if (!repo) {
        return ociErrorJson(c, 404, "NAME_UNKNOWN", `repository ${rest} not found`);
      }
      const parsed = paginationQuerySchema.safeParse({
        n: c.req.query("n"),
        last: c.req.query("last"),
      });
      if (!parsed.success) {
        return ociErrorJson(c, 400, "PAGINATION_INVALID", parsed.error.message);
      }
      const { n, last } = parsed.data;
      const page = await service.listTags(repo, { n, last });
      if (page.hasMore && page.tags.length > 0) {
        const lastTag = page.tags[page.tags.length - 1];
        if (lastTag !== undefined) {
          c.header("Link", tagsLinkHeader(rest, n, lastTag));
        }
      }
      return c.json({ name: page.name, tags: page.tags });
    } catch (e) {
      return ociError(c, e);
    }
  });

  return r;
}

async function handleStartUpload(
  c: OciContext,
  service: RegistryService,
  publisherRoles: RegistryRole[],
) {
  try {
    const principal = readPrincipal(c);
    const rest = c.req.param("rest") ?? "";

    // Distribution v2 §6.5.2 — cross-repo mount handshake.
    //
    //   POST /v2/<dst>/blobs/uploads/?mount=<digest>&from=<src>
    //
    // If `mount` parses, we attempt the mount. The destination must be
    // writable by the principal; if `from` is present the source must
    // also be readable. A blob that the registry cannot serve falls
    // through to a fresh upload session — same as if the client had
    // omitted the params entirely. This keeps clients that probe for
    // mount support from regressing to an outright failure.
    const mountParsed = mountQuerySchema.safeParse({
      mount: c.req.query("mount"),
      from: c.req.query("from"),
    });
    if (!mountParsed.success) {
      return ociErrorJson(c, 400, "DIGEST_INVALID", mountParsed.error.message);
    }
    const { mount, from } = mountParsed.data;
    if (mount) {
      // Destination must be writable.
      const { ns: dstNs } = authorize(principal, rest, "write", publisherRoles);
      // Source must be readable when `from` is supplied; if it is
      // omitted, the spec lets us still try to mount globally.
      let srcNs: ReturnType<typeof parseNamespace> | undefined;
      if (from) {
        const auth = authorize(principal, from, "read", publisherRoles);
        srcNs = auth.ns;
      }
      const result = await service.tryMountBlob({
        dstNs,
        srcNs,
        digest: mount,
        principal,
      });
      if (result.mounted) {
        c.header("Location", `/v2/${rest}/blobs/${mount}`);
        c.header("Docker-Content-Digest", mount);
        return c.body(null, 201);
      }
      // Fall through to fresh upload below.
    }

    const { ns } = authorize(principal, rest, "write", publisherRoles);
    const repo = await service.ensureRepository(ns, principal);
    const { uploadId } = await service.startUpload(repo.id);
    c.header("Location", `/v2/${rest}/blobs/uploads/${uploadId}`);
    c.header("Docker-Upload-UUID", uploadId);
    c.header("Range", "0-0");
    return c.body(null, 202);
  } catch (e) {
    return ociError(c, e);
  }
}

async function readBodyBytes(c: OciContext): Promise<Uint8Array> {
  const buf = await c.req.arrayBuffer();
  return new Uint8Array(buf);
}

function readBodyStream(c: OciContext): ReadableStream<Uint8Array> {
  return (
    c.req.raw.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    })
  );
}

function catalogLinkHeader(n: number | undefined, lastItem: string): string {
  const params = new URLSearchParams();
  if (n !== undefined) params.set("n", String(n));
  params.set("last", lastItem);
  return `</v2/_catalog?${params.toString()}>; rel="next"`;
}

function tagsLinkHeader(rest: string, n: number | undefined, lastTag: string): string {
  const params = new URLSearchParams();
  if (n !== undefined) params.set("n", String(n));
  params.set("last", lastTag);
  // The repo path segment may itself contain '/'; encode each segment so
  // the resulting URL stays parseable. The Link target is informational —
  // clients re-issue a normal GET against it.
  const encodedRest = rest
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `</v2/${encodedRest}/tags/list?${params.toString()}>; rel="next"`;
}
