import {
  type SpackInstallBindingChange,
  SpackInstallBindingChangeSchema,
  type SpackInstallBindingQuery,
  type SpackInstallBindingView,
} from "@kuintessence/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { SoftwareError } from "../../lib/software-client";
import {
  changeSpackInstallBinding,
  inspectSpackInstallBinding,
} from "../../lib/spack-install-bindings-client";

type Request = {
  controller: AbortController;
  kind: "read" | "write";
  timer?: ReturnType<typeof setTimeout>;
};
type Notice =
  | "changed"
  | "rechecked"
  | "uncertain"
  | "conflict"
  | "forbidden"
  | "unavailable"
  | "invalid";
type Options = {
  isCurrent: () => boolean;
  canInspectScope: (scope: string) => boolean;
  canWriteScope: (scope: string) => boolean;
};

function rejection(error: unknown): Notice | null {
  if (!(error instanceof SoftwareError)) return null;
  if (error.status === 409 && error.code === "INSTALL_BINDING_CONFLICT") return "conflict";
  if (
    error.status === 422 &&
    ["INSTALL_BINDING_INVALID", "VALIDATION_ERROR"].includes(error.code)
  ) {
    return "invalid";
  }
  if (
    (error.status === 401 || error.status === 403) &&
    ["UNAUTHORIZED", "INVALID_TOKEN", "FORBIDDEN", "INSTALL_BINDING_FORBIDDEN"].includes(error.code)
  ) {
    return "forbidden";
  }
  return null;
}

export function useSpackInstallBinding(options: Options) {
  const [view, setView] = useState<SpackInstallBindingView | null>(null);
  const [busy, setBusy] = useState<Request["kind"] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const active = useRef<Request | null>(null);
  const mounted = useRef(false);
  const uncertain = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const cancel = useCallback(() => {
    const request = active.current;
    active.current = null;
    if (request) {
      clearTimeout(request.timer);
      request.controller.abort();
    }
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  const current = () => mounted.current && latest.current.isCurrent();
  const live = (request: Request) =>
    current() && active.current === request && !request.controller.signal.aborted;

  function stop() {
    const request = cancel();
    if (!request || !current()) return;
    if (request.kind === "write") uncertain.current = true;
    setView(null);
    setBusy(null);
    setNotice(uncertain.current ? "uncertain" : "unavailable");
  }

  function begin(kind: Request["kind"]) {
    cancel();
    const request: Request = { controller: new AbortController(), kind };
    active.current = request;
    request.timer = setTimeout(() => {
      if (active.current === request) stop();
    }, 30_000);
    setView(null);
    setBusy(kind);
    setNotice(uncertain.current ? "uncertain" : null);
    return request;
  }

  function finish(request: Request) {
    clearTimeout(request.timer);
    if (active.current === request) {
      active.current = null;
      if (current()) setBusy(null);
    }
  }

  function reset() {
    if (!current() || active.current?.kind === "write" || uncertain.current) return false;
    cancel();
    setView(null);
    setBusy(null);
    setNotice(null);
    return true;
  }

  async function inspect(query: SpackInstallBindingQuery) {
    if (!current() || active.current || !latest.current.canInspectScope(query.scope)) return;
    const request = begin("read");
    try {
      const result = await inspectSpackInstallBinding(query, request.controller.signal);
      if (!live(request)) return;
      if (!latest.current.canInspectScope(result.scope)) {
        setNotice(uncertain.current ? "uncertain" : "forbidden");
        return;
      }
      setView(result);
      setNotice(uncertain.current ? "rechecked" : null);
      uncertain.current = false;
    } catch (error) {
      if (live(request)) {
        setNotice(uncertain.current ? "uncertain" : (rejection(error) ?? "unavailable"));
      }
    } finally {
      finish(request);
    }
  }

  async function change(command: SpackInstallBindingChange) {
    if (!current() || active.current || uncertain.current || !view) return;
    if (!latest.current.canWriteScope(view.scope)) {
      setView(null);
      setNotice("forbidden");
      return;
    }
    if (
      !SpackInstallBindingChangeSchema.safeParse(command).success ||
      command.scope !== view.scope ||
      command.spec !== view.spec ||
      command.expectedRevision !== view.revision
    ) {
      return;
    }
    const request = begin("write");
    try {
      const result = await changeSpackInstallBinding(command, request.controller.signal);
      if (!live(request)) return;
      if (!latest.current.canInspectScope(result.scope)) {
        setNotice("forbidden");
        return;
      }
      setView(result);
      setNotice("changed");
    } catch (error) {
      if (live(request)) {
        const denied = rejection(error);
        uncertain.current = denied === null;
        setNotice(denied ?? "uncertain");
      }
    } finally {
      finish(request);
    }
  }

  return {
    view,
    busy,
    notice,
    locked: busy === "write" || uncertain.current,
    inspect,
    change,
    reset,
    stop,
  };
}
