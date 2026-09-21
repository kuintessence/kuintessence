import {
  type SpackMaterialBinding,
  SpackMaterialLifecycleChangeSchema,
  type SpackMaterialLifecycleView,
} from "@kuintessence/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { SoftwareError } from "../../lib/software-client";
import {
  changeSpackMaterialLifecycle,
  getSpackMaterialLifecycle,
} from "../../lib/spack-material-lifecycle-client";

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
  | "referenced"
  | "forbidden"
  | "unavailable"
  | "invalid"
  | "failed";
type Options = {
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
  canInspectRepository: (repository: string) => boolean;
  onInvalidate: () => void;
  onSelectionLockChange?: (locked: boolean) => void;
};

function rejection(error: unknown): Notice | null {
  if (!(error instanceof SoftwareError)) return null;
  if (
    (error.status === 401 || error.status === 403) &&
    ["UNAUTHORIZED", "INVALID_TOKEN", "FORBIDDEN", "MATERIAL_LIFECYCLE_FORBIDDEN"].includes(
      error.code,
    )
  ) {
    return "forbidden";
  }
  if (error.status === 409 && error.code === "MATERIAL_RELEASE_REFERENCED") return "referenced";
  if (error.status === 409 && error.code === "MATERIAL_LIFECYCLE_CONFLICT") return "conflict";
  if (error.status === 422 && error.code === "VALIDATION_ERROR") return "invalid";
  return null;
}

export function useMaterialLifecycle(options: Options) {
  const [view, setView] = useState<SpackMaterialLifecycleView | null>(null);
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
    setBusy(null);
    setView(null);
    if (request.kind === "write") {
      uncertain.current = true;
      setNotice("uncertain");
      latest.current.onInvalidate();
    } else {
      setNotice(uncertain.current ? "uncertain" : "unavailable");
    }
  }

  function begin(kind: Request["kind"]) {
    cancel();
    const request: Request = { controller: new AbortController(), kind };
    if (kind === "write") latest.current.onSelectionLockChange?.(true);
    active.current = request;
    request.timer = setTimeout(() => {
      if (active.current === request) stop();
    }, 30_000);
    setBusy(kind);
    setView(null);
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
    cancel();
    uncertain.current = false;
    latest.current.onSelectionLockChange?.(false);
    setView(null);
    setBusy(null);
    setNotice(null);
  }

  async function inspect(binding: SpackMaterialBinding) {
    if (!current() || active.current?.kind === "write") return;
    const request = begin("read");
    try {
      const result = await getSpackMaterialLifecycle(binding, request.controller.signal);
      if (!live(request)) return;
      if (!latest.current.canInspectRepository(result.repository)) {
        setNotice(uncertain.current ? "uncertain" : "forbidden");
        return;
      }
      setView(result);
      setNotice(uncertain.current ? "rechecked" : null);
      uncertain.current = false;
      latest.current.onSelectionLockChange?.(false);
    } catch (error) {
      if (live(request)) {
        setNotice(uncertain.current ? "uncertain" : (rejection(error) ?? "unavailable"));
      }
    } finally {
      finish(request);
    }
  }

  async function change(reason: string) {
    if (!current() || active.current || !view) return;
    if (!latest.current.canWriteRepository(view.repository)) {
      setView(null);
      setNotice("forbidden");
      return;
    }
    const input = SpackMaterialLifecycleChangeSchema.safeParse({
      action: view.state === "available" ? "withdraw" : "restore",
      expectedRevision: view.revision,
      reason,
    });
    if (!input.success) {
      setNotice("invalid");
      return;
    }
    const request = begin("write");
    try {
      const result = await changeSpackMaterialLifecycle(
        view.binding,
        input.data,
        request.controller.signal,
      );
      if (!live(request)) return;
      latest.current.onInvalidate();
      latest.current.onSelectionLockChange?.(false);
      if (!latest.current.canWriteRepository(result.repository)) {
        setNotice("forbidden");
        return;
      }
      setView(result);
      setNotice("changed");
    } catch (error) {
      if (live(request)) {
        const denied = rejection(error);
        if (denied) {
          setNotice(denied);
          latest.current.onSelectionLockChange?.(false);
        } else {
          // A transport/response failure after POST does not prove rollback.
          uncertain.current = true;
          setNotice("uncertain");
          latest.current.onInvalidate();
        }
      }
    } finally {
      finish(request);
    }
  }

  return { view, busy, notice, inspect, change, stop, reset };
}
