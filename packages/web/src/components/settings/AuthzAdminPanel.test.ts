import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthzAdminPanel, canProcessAuthzOutbox } from "./AuthzAdminPanel";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthzAdminPanel state helpers", () => {
  test("enables manual processing for pending or processing outbox rows", () => {
    expect(
      canProcessAuthzOutbox({
        outbox: { pending: 1, processing: 0, dead: 0 },
      }),
    ).toBe(true);
    expect(
      canProcessAuthzOutbox({
        outbox: { pending: 0, processing: 1, dead: 0 },
      }),
    ).toBe(true);
    expect(
      canProcessAuthzOutbox({
        outbox: { pending: 0, processing: 0, dead: 1 },
      }),
    ).toBe(false);
    expect(canProcessAuthzOutbox(null)).toBe(false);
  });
});

describe("AuthzAdminPanel", () => {
  test("surfaces refresh errors without showing stale authz state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => ok({ data: health() }))
        .mockImplementationOnce(() => ok({ data: readiness() }))
        .mockImplementationOnce(() =>
          ok({
            data: [
              {
                id: "diff-1",
                actorEmail: "alice@example.com",
                resourceType: "agent",
                resourceId: "agent-1",
                permission: "view",
                localAllowed: true,
                spiceAllowed: false,
                spiceError: "denied",
                createdAt: "2026-07-08T00:00:00Z",
              },
            ],
          }),
        )
        .mockImplementationOnce(() =>
          ok({
            data: [
              {
                id: "outbox-1",
                operation: "create",
                resourceType: "agent",
                resourceId: "agent-1",
                relation: "provider",
                subjectType: "organization",
                subjectId: "org-1",
                status: "pending",
                attempts: 0,
                lastError: null,
                createdAt: "2026-07-08T00:00:00Z",
              },
            ],
          }),
        )
        .mockImplementationOnce(() =>
          ok({
            data: [
              {
                id: "membership-1",
                userId: "user-1",
                email: "alice@example.com",
                orgId: "org-1",
                role: "admin",
                updatedAt: "2026-07-08T00:00:00Z",
              },
            ],
          }),
        )
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "FORBIDDEN",
                  message: "Authorization principal is not bound",
                },
              }),
              { status: 403, headers: { "Content-Type": "application/json" } },
            ),
          ),
        ),
    );

    render(createElement(AuthzAdminPanel));

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeTruthy();
    });
    expect(screen.getByText("agent:agent-1")).toBeTruthy();
    expect(screen.getByText("agent:agent-1#provider")).toBeTruthy();

    fireEvent.click(screen.getByText("刷新"));

    await waitFor(() => screen.getByTestId("authz-refresh-error"));
    expect(screen.getByTestId("authz-refresh-error").textContent).toMatch(
      /没有执行此操作的权限|does not have permission/,
    );
    expect(screen.getByTestId("authz-refresh-error").textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.getByTestId("authz-refresh-error").textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByText("alice@example.com")).toBeNull();
    expect(screen.queryByText("agent:agent-1")).toBeNull();
    expect(screen.queryByText("agent:agent-1#provider")).toBeNull();
    expect(screen.getByText("暂无 membership")).toBeTruthy();
    expect(screen.getByText("暂无 diff")).toBeTruthy();
    expect(screen.getByText("暂无 outbox")).toBeTruthy();
  });
});

function ok(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function health() {
  return {
    mode: "enforce",
    configured: true,
    healthy: true,
    schemaWritten: true,
    schemaMatches: true,
    error: null,
    rawTupleAdminEnabled: false,
    outbox: { pending: 1, processing: 0, dead: 0 },
  };
}

function readiness() {
  return {
    mode: "enforce",
    healthy: true,
    schemaWritten: true,
    schemaMatches: true,
    outbox: { pending: 1, processing: 0, dead: 0 },
    shadowDiffs: 1,
    enforceReady: false,
    blockers: [],
    externalSmokeRequired: false,
  };
}
