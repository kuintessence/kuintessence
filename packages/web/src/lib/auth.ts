import { platformApiUrl } from "./platform-paths";

const TOKEN_KEY = "kq_token";
const SESSION_KEY = "kq_session";
const EMAIL_KEY = "kq_email";
const EXPIRES_AT_KEY = "kq_token_expires_at";
const ROLE_KEY = "kq_role";
const AUTH_REVISION_KEY = "kq_auth_revision";
export const AUTH_STATE_CHANGED_EVENT = "kq:auth-state-changed";

function notifyAuthStateChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_STATE_CHANGED_EVENT));
}

export function subscribeAuthState(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AUTH_STATE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(AUTH_STATE_CHANGED_EVENT, listener);
}

export interface AuthState {
  isAuthenticated: boolean;
  email: string | null;
  role: string | null;
  expiresAt: number | null;
  revision: string | null;
}

export function getAuthState(): AuthState {
  if (typeof localStorage === "undefined") {
    return { isAuthenticated: false, email: null, role: null, expiresAt: null, revision: null };
  }
  const token = localStorage.getItem(TOKEN_KEY);
  const session = localStorage.getItem(SESSION_KEY);
  const email = localStorage.getItem(EMAIL_KEY);
  const role = localStorage.getItem(ROLE_KEY);
  const expiresRaw = localStorage.getItem(EXPIRES_AT_KEY);
  const revision = localStorage.getItem(AUTH_REVISION_KEY);
  const expiresAt = expiresRaw ? Number.parseInt(expiresRaw, 10) || null : null;
  const isCurrent = expiresAt === null || expiresAt > Date.now();
  return {
    isAuthenticated: isCurrent && (!!token || session === "cookie"),
    email,
    role,
    expiresAt,
    revision,
  };
}

export interface SetAuthOptions {
  token?: string | null;
  email: string;
  expiresIn?: number;
  role?: string | null;
}

export function setAuth({ token, email, expiresIn, role }: SetAuthOptions): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else if (token === null) {
    localStorage.removeItem(TOKEN_KEY);
  }
  localStorage.setItem(SESSION_KEY, "cookie");
  localStorage.setItem(EMAIL_KEY, email);
  localStorage.setItem(AUTH_REVISION_KEY, crypto.randomUUID());
  if (typeof expiresIn === "number") {
    const expiresAt = Date.now() + expiresIn * 1000;
    localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));
  }
  if (role) {
    localStorage.setItem(ROLE_KEY, role);
  } else {
    localStorage.removeItem(ROLE_KEY);
  }
  notifyAuthStateChanged();
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(EMAIL_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(AUTH_REVISION_KEY);
  notifyAuthStateChanged();
}

export async function clearServerAuthSession(): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    await fetch(platformApiUrl("/auth/logout"), {
      credentials: "same-origin",
      method: "POST",
    });
  } catch {
    // Local logout must still clear browser-readable state when the Server is unreachable.
  }
}
