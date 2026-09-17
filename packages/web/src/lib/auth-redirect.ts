const LOGIN_PATH = "/login";
const POST_LOGIN_REDIRECT_KEY = "kq_post_login_redirect";

function pathOnly(target: string): string {
  return target.split(/[?#]/, 1)[0] ?? "/";
}

export function sanitizeLoginRedirect(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  if (pathOnly(value) === LOGIN_PATH) return "/";
  return value;
}

export function currentLoginRedirect(): string {
  if (typeof window === "undefined") return "/";
  return sanitizeLoginRedirect(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

export function loginUrlForRedirect(redirect = currentLoginRedirect()): string {
  const safeRedirect = sanitizeLoginRedirect(redirect);
  if (safeRedirect === "/") return LOGIN_PATH;
  return `${LOGIN_PATH}?redirect=${encodeURIComponent(safeRedirect)}`;
}

export function readLoginRedirect(): string {
  if (typeof window === "undefined") return "/";
  const params = new URLSearchParams(window.location.search);
  return sanitizeLoginRedirect(params.get("redirect"));
}

export function savePostLoginRedirect(redirect = readLoginRedirect()): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, sanitizeLoginRedirect(redirect));
  } catch {
    // sessionStorage can be unavailable in restricted browser contexts.
  }
}

export function takePostLoginRedirect(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const redirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    return redirect ? sanitizeLoginRedirect(redirect) : null;
  } catch {
    return null;
  }
}

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (pathOnly(window.location.pathname) === LOGIN_PATH) return;
  window.location.assign(loginUrlForRedirect());
}
