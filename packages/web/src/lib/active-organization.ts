import { ApiError } from "@kuintessence/shared/browser";
import { useSyncExternalStore } from "react";
import { authenticatedHeaders, fetchAuthed } from "./authenticated-fetch";

export const ACTIVE_ORGANIZATION_STORAGE_KEY = "kq_active_organization_id";

export interface ActiveOrganizationContext {
  activeOrganizationId: string | null;
  organizations: Array<{ orgId: string; name: string; role: string }>;
}

async function parse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string | { code?: string; message?: string; details?: unknown };
      errors?: Array<{ code?: string; message?: string; details?: unknown }>;
    } | null;
    const item =
      body && typeof body.error === "object" ? body.error : (body?.error ?? body?.errors?.[0]);
    const code = typeof item === "object" && item?.code ? item.code : "HTTP_ERROR";
    const message = typeof item === "string" ? item : (item?.message ?? fallback);
    const details = typeof item === "object" ? item?.details : undefined;
    throw new ApiError(response.status, code, message, details);
  }
  return response.json() as Promise<T>;
}

export function getStoredActiveOrganizationId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
}

function subscribeToActiveOrganization(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("kq:active-organization-change", onStoreChange);
  return () => window.removeEventListener("kq:active-organization-change", onStoreChange);
}

function storeActiveOrganizationId(organizationId: string | null): void {
  if (typeof localStorage === "undefined") return;
  const previous = getStoredActiveOrganizationId();
  if (organizationId) localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, organizationId);
  else localStorage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  if (previous !== organizationId && typeof window !== "undefined") {
    window.dispatchEvent(new Event("kq:active-organization-change"));
  }
}

export function useActiveOrganizationId(enabled = true): string | null {
  return useSyncExternalStore(
    enabled ? subscribeToActiveOrganization : () => () => undefined,
    enabled ? getStoredActiveOrganizationId : () => null,
    () => null,
  );
}

export async function getActiveOrganizationContext(): Promise<ActiveOrganizationContext> {
  const context = await fetchAuthed("/me/active-organization", () => ({
    credentials: "same-origin",
    headers: authenticatedHeaders(),
  })).then((response) => parse<ActiveOrganizationContext>(response, "无法加载当前组织"));
  storeActiveOrganizationId(context.activeOrganizationId);
  return context;
}

export async function setActiveOrganization(organizationId: string | null): Promise<void> {
  await fetchAuthed("/me/active-organization", () => ({
    credentials: "same-origin",
    method: "PUT",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ organizationId }),
  })).then((response) =>
    parse<{ activeOrganizationId: string | null }>(response, "无法更新当前组织"),
  );
  storeActiveOrganizationId(organizationId);
}
