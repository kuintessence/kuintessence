import { type RecipeActivation, RecipeRepositorySchema } from "@kuintessence/shared/browser";
import { requestSoftwareJson, SoftwareError, softwareWriteHeaders } from "./software-client";

const BASE = "/spack/recipe-repositories";
const listSchema = RecipeRepositorySchema.array();

function parse<T>(
  body: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid recipe repository response");
  }
  return parsed.data;
}

async function requestRepository(path: string, init?: RequestInit) {
  return parse(await requestSoftwareJson<unknown>(path, init), RecipeRepositorySchema);
}

export async function listRecipeRepositories() {
  const body = await requestSoftwareJson<{ repositories?: unknown } | null>(BASE);
  return parse(body?.repositories, listSchema);
}

export function getRecipeRepository(id: string) {
  return requestRepository(`${BASE}/${encodeURIComponent(id)}`);
}

export function importRecipeRepository(repository: string, file: File) {
  return requestRepository(`${BASE}/import?repository=${encodeURIComponent(repository)}`, {
    method: "POST",
    headers: { ...softwareWriteHeaders(), "Content-Type": "application/octet-stream" },
    body: file,
  });
}

export function activateRecipeRepository(id: string, activation: RecipeActivation) {
  return requestRepository(`${BASE}/${encodeURIComponent(id)}/active`, {
    method: "PUT",
    headers: softwareWriteHeaders(),
    body: JSON.stringify(activation),
  });
}

export function deactivateRecipeRepository(id: string, expectedActiveCommit: string) {
  return requestRepository(`${BASE}/${encodeURIComponent(id)}/active`, {
    method: "DELETE",
    headers: softwareWriteHeaders(),
    body: JSON.stringify({ expectedActiveCommit }),
  });
}
