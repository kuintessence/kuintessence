import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DesensitizeAdminPanel } from "./DesensitizeAdminPanel";

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const config = {
  globalEnabled: false,
  exportEnabled: true,
  rules: [
    {
      id: "rule-1",
      scope: "global",
      scopeId: null,
      fieldPath: "actor",
      action: "alias",
      updatedAt: "2026-08-07T00:00:00.000Z",
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("DesensitizeAdminPanel", () => {
  test("loads, updates, and exports without persisting the envelope", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, url, body });
        if (method === "GET") return new Response(JSON.stringify(config), { status: 200 });
        if (method === "PUT") {
          return new Response(
            JSON.stringify({ ...config, globalEnabled: true, rules: config.rules }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ token: "short-lived-envelope", expiresIn: 600 }), {
          status: 200,
        });
      }),
    );

    render(<DesensitizeAdminPanel />);
    const toggle = await screen.findByTestId("desensitize-global-enabled");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("desensitize-save"));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      globalEnabled: true,
      rules: [{ scope: "global", scopeId: null, fieldPath: "actor", action: "alias" }],
    });

    fireEvent.change(screen.getByTestId("desensitize-alias-ids"), {
      target: { value: "alias-one\nalias-two" },
    });
    fireEvent.click(screen.getByTestId("desensitize-export"));

    await screen.findByTestId("desensitize-envelope");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      aliasIds: ["alias-one", "alias-two"],
    });
    expect(screen.getByDisplayValue("short-lived-envelope")).toBeTruthy();
  });

  test("shows export as unavailable when the Server has no export key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...config, exportEnabled: false }), { status: 200 }),
      ),
    );
    render(<DesensitizeAdminPanel />);

    await screen.findByTestId("desensitize-export-disabled");
    expect((screen.getByTestId("desensitize-export") as HTMLButtonElement).disabled).toBe(true);
  });

  test("does not mount the destructive editor when config loading fails", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "config unavailable" } }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DesensitizeAdminPanel />);

    await screen.findByTestId("desensitize-load-error");
    expect(screen.queryByTestId("desensitize-save")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("clears a previous envelope before a failed export retry", async () => {
    let exportAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify(config), { status: 200 });
        }
        exportAttempts += 1;
        return exportAttempts === 1
          ? new Response(JSON.stringify({ token: "first-envelope", expiresIn: 600 }), {
              status: 200,
            })
          : new Response(JSON.stringify({ error: { message: "export unavailable" } }), {
              status: 503,
            });
      }),
    );
    render(<DesensitizeAdminPanel />);

    await screen.findByTestId("desensitize-global-enabled");
    fireEvent.change(screen.getByTestId("desensitize-alias-ids"), {
      target: { value: "alias-one" },
    });
    fireEvent.click(screen.getByTestId("desensitize-export"));
    await screen.findByTestId("desensitize-envelope");

    fireEvent.click(screen.getByTestId("desensitize-export"));
    await waitFor(() => expect(screen.queryByTestId("desensitize-envelope")).toBeNull());
  });

  test("removes an envelope when its server TTL expires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? new Response(JSON.stringify(config), { status: 200 })
          : new Response(JSON.stringify({ token: "expiring-envelope", expiresIn: 0.05 }), {
              status: 200,
            }),
      ),
    );
    render(<DesensitizeAdminPanel />);

    await screen.findByTestId("desensitize-global-enabled");
    fireEvent.change(screen.getByTestId("desensitize-alias-ids"), {
      target: { value: "alias-one" },
    });
    fireEvent.click(screen.getByTestId("desensitize-export"));
    await screen.findByTestId("desensitize-envelope");
    await waitFor(() => expect(screen.queryByTestId("desensitize-envelope")).toBeNull(), {
      timeout: 500,
    });
  });
});
