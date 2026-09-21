import {
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  type SpackMaterialVisibilityChange,
  SpackMaterialVisibilityChangeSchema,
  type SpackMaterialVisibilityView,
  SpackMaterialVisibilityViewSchema,
} from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError, softwareWriteHeaders } from "./software-client";

function parse<T>(
  input: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  status: 422 | 502,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new SoftwareError(
      status,
      status === 422 ? "VALIDATION_ERROR" : "REGISTRY_INVALID_RESPONSE",
      status === 422
        ? "Invalid Spack material visibility input"
        : "Invalid Spack material visibility response",
    );
  }
  return parsed.data;
}

function invalidResponse(): SoftwareError {
  return new SoftwareError(
    502,
    "REGISTRY_INVALID_RESPONSE",
    "Invalid Spack material visibility response",
  );
}

async function requestVisibility(
  binding: SpackMaterialBinding,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<SpackMaterialVisibilityView> {
  signal?.throwIfAborted();
  const path = `/spack/material-repositories/${encodeURIComponent(binding.repositoryId)}/releases/${encodeURIComponent(binding.manifestDigest)}/visibility`;
  try {
    const body = await requestSoftwareJson<unknown>(path, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
    });
    signal?.throwIfAborted();
    const view = parse(body, SpackMaterialVisibilityViewSchema, 502);
    if (
      view.binding.repositoryId !== binding.repositoryId ||
      view.binding.manifestDigest !== binding.manifestDigest
    ) {
      throw invalidResponse();
    }
    let digest: ArrayBuffer;
    try {
      digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(view.repository));
    } catch {
      signal?.throwIfAborted();
      throw invalidResponse();
    }
    signal?.throwIfAborted();
    const repositoryId = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (repositoryId !== binding.repositoryId) throw invalidResponse();
    return view;
  } catch (error) {
    // The transport wraps cancellation; preserve the original abort reason.
    signal?.throwIfAborted();
    throw error;
  }
}

export async function getSpackMaterialVisibility(
  binding: SpackMaterialBinding,
  signal?: AbortSignal,
): Promise<SpackMaterialVisibilityView> {
  signal?.throwIfAborted();
  const expected = parse(binding, SpackMaterialBindingSchema, 422);
  return requestVisibility(expected, { method: "GET" }, signal);
}

export async function changeSpackMaterialVisibility(
  binding: SpackMaterialBinding,
  change: SpackMaterialVisibilityChange,
  signal?: AbortSignal,
): Promise<SpackMaterialVisibilityView> {
  signal?.throwIfAborted();
  const expected = parse(binding, SpackMaterialBindingSchema, 422);
  const command = parse(change, SpackMaterialVisibilityChangeSchema, 422);
  const view = await requestVisibility(
    expected,
    {
      method: "POST",
      headers: softwareWriteHeaders(),
      body: JSON.stringify(command),
    },
    signal,
  );
  signal?.throwIfAborted();
  if (
    view.revision !== command.expectedRevision + 1 ||
    JSON.stringify(view.policy) !== JSON.stringify(command.policy) ||
    view.history[0]?.reason !== command.reason
  ) {
    // An invalid receipt does not prove rollback. Never repeat the write automatically.
    throw invalidResponse();
  }
  return view;
}
