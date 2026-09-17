import { Navigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { refreshAuthSession } from "../lib/api-client";
import { getAuthState } from "../lib/auth";
import { sanitizeLoginRedirect } from "../lib/auth-redirect";
import { ensureLocalSession } from "../lib/local-mode";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  // In local mode, promote the shell-injected token into a session before
  // reading auth state, so a locally-trusted entry isn't bounced to /login.
  ensureLocalSession();
  const auth = getAuthState();
  const location = useRouterState({ select: (s) => s.location });
  const [checkingCookieSession, setCheckingCookieSession] = useState(!auth.isAuthenticated);
  const [sessionAuthenticated, setSessionAuthenticated] = useState(auth.isAuthenticated);
  const redirect = sanitizeLoginRedirect(
    `${location.pathname}${location.searchStr}${location.hash ?? ""}`,
  );

  useEffect(() => {
    if (auth.isAuthenticated) {
      setSessionAuthenticated(true);
      setCheckingCookieSession(false);
      return;
    }

    let cancelled = false;
    setCheckingCookieSession(true);
    refreshAuthSession()
      .then((authenticated) => {
        if (cancelled) return;
        setSessionAuthenticated(authenticated);
      })
      .catch(() => {
        if (!cancelled) {
          setSessionAuthenticated(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCheckingCookieSession(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [auth.isAuthenticated]);

  if (checkingCookieSession) {
    return null;
  }

  if (!sessionAuthenticated) {
    return <Navigate to="/login" search={redirect === "/" ? undefined : { redirect }} replace />;
  }
  return <>{children}</>;
}
