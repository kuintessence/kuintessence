/**
 * In-binary SPA map consumed by `kq gui serve` (via {@link createGuiServer}'s
 * `embeddedSpa` option) so a single compiled `kq` binary can serve the GUI with
 * no disk SPA.
 *
 * Committed EMPTY on purpose: the normal `kq` build imports this as `{}`, which
 * keeps that binary SPA-free (`kq gui serve` without `--web-dir` stays API-only).
 * Only the dedicated `gui:single-binary` build transiently OVERWRITES this file
 * (via `scripts/gui-embed-spa.ts`), compiles `kq` with the populated map, then
 * restores the empty version — so the working tree always stays clean.
 *
 * Keys are SPA-relative paths (e.g. `index.html`, `assets/app.js`).
 */
export const EMBEDDED_SPA: Record<string, { type: string; base64: string }> = {};
