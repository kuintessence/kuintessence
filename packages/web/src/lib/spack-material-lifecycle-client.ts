import {
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  type SpackMaterialLifecycleChange,
  SpackMaterialLifecycleChangeSchema,
  type SpackMaterialLifecycleView,
  SpackMaterialLifecycleViewSchema,
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
        ? "Invalid Spack material lifecycle input"
        : "Invalid Spack material lifecycle response",
    );
  }
  return parsed.data;
}

function invalidResponse(): SoftwareError {
  return new SoftwareError(
    502,
    "REGISTRY_INVALID_RESPONSE",
    "Invalid Spack material lifecycle response",
  );
}

async function requestLifecycle(
  binding: SpackMaterialBinding,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<SpackMaterialLifecycleView> {
  signal?.throwIfAborted();
  const path = `/spack/material-repositories/${encodeURIComponent(binding.repositoryId)}/releases/${encodeURIComponent(binding.manifestDigest)}/lifecycle`;
  try {
    const body = await requestSoftwareJson<unknown>(path, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
    });
    signal?.throwIfAborted();
    const view = parse(body, SpackMaterialLifecycleViewSchema, 502);
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
    // The shared transport wraps fetch/body cancellation; preserve the caller's signal.
    signal?.throwIfAborted();
    throw error;
  }
}

export async function getSpackMaterialLifecycle(
  binding: SpackMaterialBinding,
  signal?: AbortSignal,
): Promise<SpackMaterialLifecycleView> {
  signal?.throwIfAborted();
  const expected = parse(binding, SpackMaterialBindingSchema, 422);
  return requestLifecycle(expected, { method: "GET" }, signal);
}

export async function changeSpackMaterialLifecycle(
  binding: SpackMaterialBinding,
  change: SpackMaterialLifecycleChange,
  signal?: AbortSignal,
): Promise<SpackMaterialLifecycleView> {
  signal?.throwIfAborted();
  const expected = parse(binding, SpackMaterialBindingSchema, 422);
  const command = parse(change, SpackMaterialLifecycleChangeSchema, 422);
  const view = await requestLifecycle(
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
    view.state !== (command.action === "withdraw" ? "withdrawn" : "available") ||
    view.history[0]?.reason !== command.reason
  ) {
    // A rejected receipt does not establish whether the mutation committed. Never retry here.
    throw invalidResponse();
  }
  return view;
}
