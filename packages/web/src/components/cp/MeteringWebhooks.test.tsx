import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { MeteringWebhooks } from "./MeteringWebhooks";

interface WebhookBody {
  id: string;
  orgId: string;
  url: string;
  enabled: boolean;
  events: string[];
  failures: number;
  createdAt: string;
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubApi(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status = 200, body } = handler(url, init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const existing: WebhookBody = {
  id: "w1",
  orgId: "o",
  url: "https://x/h",
  enabled: true,
  events: ["usage.daily"],
  failures: 0,
  createdAt: "2026-06-01T00:00:00Z",
};

function defaultHandler(items: WebhookBody[]): Handler {
  return (url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("/metering/webhook") && method === "GET") {
      return { body: { items } };
    }
    if (url.endsWith("/metering/webhook") && method === "POST") {
      return {
        status: 201,
        body: {
          id: "w2",
          orgId: "o",
          url: "https://new/h",
          enabled: true,
          events: ["usage.daily"],
          createdAt: "2026-06-02T00:00:00Z",
        },
      };
    }
    if (method === "DELETE") {
      return { body: { ok: true } };
    }
    return { body: {} };
  };
}

function postCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find(
    (c) => String(c[0]).includes("/metering/webhook") && (c[1]?.method ?? "GET") === "POST",
  );
}

function deleteCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find((c) => (c[1]?.method ?? "GET") === "DELETE");
}

beforeEach(() => {
  localStorage.setItem("kq_token", "test-token");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("MeteringWebhooks", () => {
  test("renders an existing webhook row with url and events", async () => {
    stubApi(defaultHandler([existing]));

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("webhook-row-0")).toBeTruthy();
    });
    const rowEl = screen.getByTestId("webhook-row-0");
    expect(rowEl.textContent).toContain("https://x/h");
    expect(rowEl.textContent).toContain("usage.daily");
    const scroller = screen.getByTestId("webhook-table-scroll");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("min-w-[52rem]");
  });

  test("filling the form and clicking Add fires a POST with the form body", async () => {
    const fetchMock = stubApi(defaultHandler([existing]));

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("webhook-row-0")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: "https://new/h" },
    });
    fireEvent.change(screen.getByTestId("webhook-secret"), {
      target: { value: "longenoughsecret" },
    });
    fireEvent.click(screen.getByTestId("webhook-event-daily"));
    fireEvent.click(screen.getByTestId("webhook-add"));

    await waitFor(() => {
      expect(postCall(fetchMock)).toBeTruthy();
    });
    const call = postCall(fetchMock);
    const body = JSON.parse(String(call?.[1]?.body)) as {
      url: string;
      secret: string;
      events: string[];
      enabled: boolean;
    };
    expect(body.url).toBe("https://new/h");
    expect(body.secret).toBe("longenoughsecret");
    expect(body.events).toContain("usage.daily");
    expect(body.enabled).toBe(true);
  });

  test("a too-short secret shows a toast.error and does not POST", async () => {
    const fetchMock = stubApi(defaultHandler([existing]));

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("webhook-row-0")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: "https://new/h" },
    });
    fireEvent.change(screen.getByTestId("webhook-secret"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByTestId("webhook-event-daily"));
    fireEvent.click(screen.getByTestId("webhook-add"));

    expect(toastError).toHaveBeenCalled();
    expect(postCall(fetchMock)).toBeFalsy();
  });

  test("clicking delete fires DELETE /api/metering/webhook/w1", async () => {
    const fetchMock = stubApi(defaultHandler([existing]));

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("webhook-row-0")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("webhook-delete-0"));

    await waitFor(() => {
      expect(deleteCall(fetchMock)).toBeTruthy();
    });
    expect(String(deleteCall(fetchMock)?.[0])).toContain("/metering/webhook/w1");
  });

  test("surfaces refetch errors without showing stale webhook rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [existing] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });
    await waitFor(() => screen.getByTestId("webhook-row-0"));

    fireEvent.click(screen.getByTestId("webhook-delete-0"));

    await waitFor(() => screen.getByTestId("webhooks-error"));
    const error = screen.getByTestId("webhooks-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect(screen.queryByTestId("webhook-row-0")).toBeNull();
    expect(screen.queryByTestId("webhook-delete-0")).toBeNull();
    expect(screen.queryByTestId("webhooks-empty")).toBeNull();
  });

  test("disables creation when the webhook list is not trusted", async () => {
    const fetchMock = stubApi((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/metering/webhook") && method === "GET") {
        return {
          status: 403,
          body: {
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          },
        };
      }
      return { status: 201, body: {} };
    });

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("webhooks-error"));
    const error = screen.getByTestId("webhooks-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect((screen.getByTestId("webhook-url") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("webhook-secret") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("webhook-event-daily") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("webhook-enabled") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("webhook-add") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("webhook-add"));

    expect(postCall(fetchMock)).toBeFalsy();
  });

  test("empty items renders the empty state", async () => {
    stubApi(defaultHandler([]));

    render(<MeteringWebhooks />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("webhooks-empty")).toBeTruthy();
    });
  });
});
