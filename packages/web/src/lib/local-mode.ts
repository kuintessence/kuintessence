import { useEffect, useState } from "react";
import { api } from "./api-client";
import { getAuthState, setAuth } from "./auth";

export interface KqLocal {
  baseUrl: string;
  token?: string;
}

declare global {
  interface Window {
    __KQ_LOCAL__?: KqLocal;
  }
}

export function isLocalMode(): boolean {
  return typeof window !== "undefined" && !!window.__KQ_LOCAL__;
}

export function localApiBase(): string | undefined {
  return typeof window !== "undefined" ? window.__KQ_LOCAL__?.baseUrl : undefined;
}

export function localToken(): string | undefined {
  return typeof window !== "undefined" ? window.__KQ_LOCAL__?.token : undefined;
}

/**
 * In local mode the desktop shell (`kq gui`) has already injected a trusted
 * token via `window.__KQ_LOCAL__`, so there is no human to walk through the
 * dev-login form. The route guard authenticates off `localStorage` (see
 * {@link getAuthState}), which `__KQ_LOCAL__` does not populate — so without
 * this the SPA would bounce a locally-trusted session to `/login`.
 *
 * This promotes the injected token into a persisted session exactly once (when
 * none exists yet), giving local mode a frictionless auto-authenticated entry.
 * It is a no-op outside local mode, when no token was injected, or when a
 * session already exists, so Server mode is untouched. Returns whether a session
 * is now present.
 */
export function ensureLocalSession(): boolean {
  if (!isLocalMode()) return getAuthState().isAuthenticated;
  if (getAuthState().isAuthenticated) return true;
  const token = localToken();
  if (!token) return false;
  setAuth({ token, email: "local", role: "user" });
  return true;
}

/**
 * Mirrors the `kq gui serve` `TuiBackendCapabilities` shape served at
 * `GET /api/capabilities`. A bare-node local server may not back every panel
 * (e.g. no workflow engine / agent registry), so the SPA reads this once to
 * decide which nav items are honest to show in local mode.
 */
export interface LocalCapabilities {
  jobs: boolean;
  submit: boolean;
  logs: boolean;
  workflows: boolean;
  agents: boolean;
  metrics: boolean;
  software: boolean;
  ssh: boolean;
}

let capabilitiesPromise: Promise<LocalCapabilities | null> | undefined;

/**
 * Fetch (and process-cache) the local server's capabilities. Only meaningful in
 * local mode; resolves `null` outside it or on any fetch error so callers can
 * fall back to a safe default. Idempotent: the underlying request fires once.
 */
export function fetchLocalCapabilities(): Promise<LocalCapabilities | null> {
  if (!isLocalMode()) return Promise.resolve(null);
  if (!capabilitiesPromise) {
    capabilitiesPromise = api.get<LocalCapabilities>("/capabilities").catch(() => null);
  }
  return capabilitiesPromise;
}

/** Test-only: drop the cached capabilities promise between cases. */
export function __resetLocalCapabilitiesCache(): void {
  capabilitiesPromise = undefined;
}

/**
 * In local mode, resolves to the server's capabilities (or `null` while still
 * loading / on error). Outside local mode it stays `null` and fires no request.
 */
export function useLocalCapabilities(): LocalCapabilities | null {
  const [caps, setCaps] = useState<LocalCapabilities | null>(null);

  useEffect(() => {
    if (!isLocalMode()) return;
    let active = true;
    fetchLocalCapabilities().then((c) => {
      if (active) setCaps(c);
    });
    return () => {
      active = false;
    };
  }, []);

  return caps;
}
