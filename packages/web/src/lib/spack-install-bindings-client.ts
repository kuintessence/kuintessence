import {
  type SpackInstallBindingChange,
  SpackInstallBindingChangeSchema,
  type SpackInstallBindingQuery,
  SpackInstallBindingQuerySchema,
  type SpackInstallBindingView,
  SpackInstallBindingViewSchema,
  type SpackMaterialBinding,
} from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError, softwareWriteHeaders } from "./software-client";

function parse<T>(
  input: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  status: 422 | 502,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new SoftwareError(
      status,
      status === 422 ? "VALIDATION_ERROR" : "REGISTRY_INVALID_RESPONSE",
      "Invalid Spack install binding",
    );
  }
  return result.data;
}

export function sameInstallBinding(
  left: SpackMaterialBinding | null,
  right: SpackMaterialBinding | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.repositoryId === right.repositoryId && left.manifestDigest === right.manifestDigest;
}

function invalidResponse(): never {
  throw new SoftwareError(
    502,
    "REGISTRY_INVALID_RESPONSE",
    "Invalid Spack install binding receipt",
  );
}

function validateView(body: unknown, query: SpackInstallBindingQuery): SpackInstallBindingView {
  const view = parse(body, SpackInstallBindingViewSchema, 502);
  if (
    view.scope !== query.scope ||
    view.spec !== query.spec ||
    view.revision > 2_147_483_647 ||
    (view.state === "enabled") !== (view.binding !== null) ||
    (view.state === "absent") !== (view.revision === 0) ||
    view.history.length !== Math.min(view.revision, 100) ||
    view.historyTruncated !== (view.revision > 100)
  ) {
    invalidResponse();
  }
  for (const [index, event] of view.history.entries()) {
    if (
      event.revision !== view.revision - index ||
      (event.state === "enabled") !== (event.binding !== null) ||
      (event.source === "web" && event.operatorId === null) ||
      (index === 0 &&
        (event.state !== view.state || !sameInstallBinding(event.binding, view.binding)))
    ) {
      invalidResponse();
    }
  }
  return view;
}

async function requestBinding(
  path: string,
  input: SpackInstallBindingQuery | SpackInstallBindingChange,
  signal?: AbortSignal,
): Promise<SpackInstallBindingView> {
  signal?.throwIfAborted();
  try {
    const body = await requestSoftwareJson<unknown>(path, {
      method: "POST",
      headers: softwareWriteHeaders(),
      body: JSON.stringify(input),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    signal?.throwIfAborted();
    return validateView(body, input);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

export async function inspectSpackInstallBinding(
  query: SpackInstallBindingQuery,
  signal?: AbortSignal,
): Promise<SpackInstallBindingView> {
  signal?.throwIfAborted();
  return requestBinding(
    "/spack/install-bindings/inspect",
    parse(query, SpackInstallBindingQuerySchema, 422),
    signal,
  );
}

export async function changeSpackInstallBinding(
  change: SpackInstallBindingChange,
  signal?: AbortSignal,
): Promise<SpackInstallBindingView> {
  signal?.throwIfAborted();
  const command = parse(change, SpackInstallBindingChangeSchema, 422);
  const view = await requestBinding("/spack/install-bindings", command, signal);
  signal?.throwIfAborted();
  const event = view.history[0];
  if (
    view.revision !== command.expectedRevision + 1 ||
    view.state !== (command.action === "bind" ? "enabled" : "disabled") ||
    !sameInstallBinding(view.binding, command.action === "bind" ? command.binding : null) ||
    event?.reason !== command.reason ||
    event?.source !== "web"
  ) {
    // A malformed receipt cannot establish rollback. The caller must inspect before retrying.
    invalidResponse();
  }
  return view;
}
