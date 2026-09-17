import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const AUTH_SESSION_COOKIE = "kq_access_token";
export const AUTH_REFRESH_COOKIE = "kq_refresh_token";

export function readAuthSessionCookie(c: Context): string | undefined {
  return getCookie(c, AUTH_SESSION_COOKIE);
}

export function setAuthSessionCookie(
  c: Context,
  token: string,
  options: { maxAgeSec: number; secure: boolean },
): void {
  setCookie(c, AUTH_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: "Lax",
    path: "/",
    maxAge: options.maxAgeSec,
  });
}

export function readAuthRefreshCookie(c: Context): string | undefined {
  return getCookie(c, AUTH_REFRESH_COOKIE);
}

export function setAuthRefreshCookie(
  c: Context,
  token: string,
  options: { maxAgeSec: number; secure: boolean },
): void {
  setCookie(c, AUTH_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: options.maxAgeSec,
  });
}

export function clearAuthSessionCookie(c: Context): void {
  deleteCookie(c, AUTH_SESSION_COOKIE, { path: "/" });
}

export function clearAuthRefreshCookie(c: Context): void {
  deleteCookie(c, AUTH_REFRESH_COOKIE, { path: "/api/auth" });
}
