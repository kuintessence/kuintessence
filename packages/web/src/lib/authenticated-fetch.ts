import { unwrapApiResponse } from "@kuintessence/shared/browser";
import { clearAuth, setAuth } from "./auth";
import { redirectToLogin } from "./auth-redirect";
import { localApiBase, localToken } from "./local-mode";
import { PLATFORM_API_BASE } from "./platform-paths";

interface AuthSessionResponse {
  authenticated: boolean;
  expiresIn?: number;
  user?: {
    email: string;
    role: string;
  };
}

function apiBase(): string {
  return localApiBase() ?? PLATFORM_API_BASE;
}

export function authenticatedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token =
    localToken() ?? (typeof localStorage === "undefined" ? null : localStorage.getItem("kq_token"));
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

function isAuthRedirectCandidate(path: string): boolean {
  return !path.startsWith("/auth/");
}

function shouldRedirectUnauthorized(path: string): boolean {
  return isAuthRedirectCandidate(path) && localApiBase() == null;
}

function applyCookieSession(session: AuthSessionResponse): boolean {
  if (!session.authenticated || !session.user) return false;
  setAuth({
    token: null,
    email: session.user.email,
    expiresIn: session.expiresIn,
    role: session.user.role,
  });
  return true;
}

async function readCookieSession(): Promise<boolean> {
  const response = await fetch(`${apiBase()}/auth/session`, { credentials: "same-origin" });
  if (!response.ok) return false;
  return applyCookieSession(await unwrapApiResponse<AuthSessionResponse>(response));
}

async function requestSessionRefresh(): Promise<boolean> {
  const response = await fetch(`${apiBase()}/auth/session/refresh`, {
    credentials: "same-origin",
    method: "POST",
  });
  if (!response.ok) return false;
  return applyCookieSession(await unwrapApiResponse<AuthSessionResponse>(response));
}

async function refreshWithBrowserLock(): Promise<boolean> {
  // A second tab may have rotated the shared cookie while this tab waited.
  // Re-read first so only one refresh token is consumed for the same expiry.
  if (await readCookieSession()) return true;
  return requestSessionRefresh();
}

let refreshRequest: Promise<boolean> | null = null;

export function refreshAuthSession(): Promise<boolean> {
  if (localApiBase() != null) return Promise.resolve(false);
  if (refreshRequest) return refreshRequest;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  refreshRequest = (
    locks
      ? locks.request("kq-auth-refresh", { mode: "exclusive" }, refreshWithBrowserLock)
      : refreshWithBrowserLock()
  )
    .catch(() => false)
    .finally(() => {
      refreshRequest = null;
    });
  return refreshRequest;
}

export async function fetchAuthed(path: string, createInit: () => RequestInit): Promise<Response> {
  let response = await fetch(`${apiBase()}${path}`, createInit());
  if (response.status !== 401 || !shouldRedirectUnauthorized(path)) return response;
  if (await refreshAuthSession()) {
    response = await fetch(`${apiBase()}${path}`, createInit());
    if (response.status !== 401) return response;
  }
  clearAuth();
  redirectToLogin();
  return response;
}
