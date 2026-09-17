// Public DSL JSON Schema route.
//
// Serves the control-flow workflow DSL JSON Schema.
// External editors (Monaco YAML extension, VS Code YAML extension, IDE
// plugins) and CI lint tools fetch the workflow DSL schema from a stable
// HTTPS URL instead of bundling a copy. Serving it from the Server keeps the
// editor surface aligned with the runtime parser without requiring a
// republished npm package on every DSL tweak — the body is generated from
// the same Zod source of truth the parser uses.
//
// The route is intentionally public: a JSON Schema is not sensitive, and
// authenticated discovery would defeat the point (CI runners that lint a
// PR should not need a Server credential just to pull a schema). Mount this
// router BEFORE the `protectedApi` block in `index.ts`.

import { WORKFLOW_JSON_SCHEMA } from "@kuintessence/shared";
import { Hono } from "hono";

/**
 * Compute a stable ETag from the serialized schema body.
 *
 * We use a tiny FNV-1a hash so the route stays self-contained — bringing
 * crypto into the hot path for a 1-second cache lookup is overkill, and
 * collision risk on a single static document is irrelevant in practice.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Equivalent to `hash *= 0x01000193` mod 2^32, written without bigints.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const SCHEMA_CONTENT_TYPE = "application/schema+json; charset=utf-8";

/**
 * Hono router that serves the workflow DSL JSON Schema at a stable URL:
 *   - `GET /api/dsl/schema/workflow` — the control-flow DSL.
 *
 * `Cache-Control: public, max-age=3600` lets edge caches reuse the body, and
 * `ETag` lets clients (the Monaco YAML extension in particular) skip the
 * payload on subsequent reloads via `If-None-Match`.
 */
export const dslRoutes = new Hono();

/** Register a GET endpoint that serves a pre-serialized JSON Schema with a
 *  stable ETag and 304 conditional-GET support. Body is serialized once at
 *  module load so the response and ETag share an identical byte stream. */
function registerSchemaRoute(path: string, schema: unknown): void {
  const body = JSON.stringify(schema);
  const etag = `"${fnv1aHex(body)}"`;
  dslRoutes.get(path, (c) => {
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=3600" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": SCHEMA_CONTENT_TYPE,
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
      },
    });
  });
}

registerSchemaRoute("/dsl/schema/workflow", WORKFLOW_JSON_SCHEMA);
