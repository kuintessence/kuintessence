import { createMiddleware } from "hono/factory";

/**
 * Baseline response security headers — the subset that is unambiguously safe
 * for a JSON API consumed cross-origin by the SPA.
 *
 * Deliberately excludes `Cross-Origin-{Resource,Opener,Embedder}-Policy`.
 * `Content-Security-Policy` is emitted only when the deployment passes an
 * explicit policy because it must match the actual SPA hosting shape. The three
 * baseline headers have no bearing on CORS / cross-origin resource access:
 *
 * - `X-Content-Type-Options: nosniff` — stop MIME-sniffing of API responses.
 * - `X-Frame-Options: DENY` — the API is fetched, never framed (clickjacking).
 * - `Referrer-Policy: no-referrer` — don't leak URLs (which can carry the WS
 *   `?token=`) via the Referer header.
 */
export interface SecurityHeaderOptions {
  contentSecurityPolicy?: string;
}

export function securityHeaders(options: SecurityHeaderOptions = {}) {
  return createMiddleware(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    if (options.contentSecurityPolicy) {
      c.header("Content-Security-Policy", options.contentSecurityPolicy);
    }
  });
}
