import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ACTIVE_ORGANIZATION_STORAGE_KEY,
  getActiveOrganizationContext,
  getStoredActiveOrganizationId,
  setActiveOrganization,
} from "./active-organization";
import { setAuth } from "./auth";

beforeEach(() => {
  localStorage.clear();
  setAuth({ token: null, email: "member@example.test", role: "user" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-a");
});
afterEach(() => vi.restoreAllMocks());

test.each([
  "read",
  "write",
])("stale %s response cannot replace a newer institution selection", async (action) => {
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const request =
    action === "read" ? getActiveOrganizationContext() : setActiveOrganization("org-b");
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-c");
  response.resolve(
    new Response(JSON.stringify({ activeOrganizationId: "org-b", organizations: [] })),
  );
  await expect(request).rejects.toMatchObject({ code: "ORGANIZATION_CONTEXT_CHANGED" });
  expect(getStoredActiveOrganizationId()).toBe("org-c");
});

test("an earlier login cannot overwrite the new login's institution", async () => {
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const request = getActiveOrganizationContext();
  setAuth({ token: null, email: "new-member@example.test", role: "user" });
  response.resolve(
    new Response(JSON.stringify({ activeOrganizationId: "org-b", organizations: [] })),
  );
  await expect(request).rejects.toMatchObject({ code: "ORGANIZATION_CONTEXT_CHANGED" });
  expect(getStoredActiveOrganizationId()).toBe("org-a");
});

test("successful selection stores the institution and notifies mounted pages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ activeOrganizationId: "org-b" }))),
  );
  const changed = vi.fn();
  window.addEventListener("kq:active-organization-change", changed);
  try {
    await setActiveOrganization("org-b");
    expect(getStoredActiveOrganizationId()).toBe("org-b");
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("kq:active-organization-change", changed);
  }
});
