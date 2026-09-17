/**
 * CostRatesForm component tests.
 *
 * Covers:
 *   - GET /preferences/global prefills the per-cluster rate rows (spec also has
 *     softWeights set, which must survive a save unchanged)
 *   - editing a rate + Save issues a PUT whose body has the updated costRates
 *     AND preserves the original softWeights (read-modify-write proof)
 *   - a negative/NaN rate triggers toast.error and issues NO PUT
 *   - load failure shows an error boundary and exposes no write actions
 */

import type { PreferenceSpec } from "@kuintessence/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { CostRatesForm } from "./CostRatesForm";

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CostRatesForm", () => {
  test("prefills rows from a GET spec that also has softWeights", async () => {
    const spec: PreferenceSpec = {
      softWeights: {
        loadWeight: 1,
        costWeight: 2,
        localityWeight: 1,
        queueWaitWeight: 1,
      },
      costRates: { "cluster-a": 0.5, "cluster-b": 1.25 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ spec }), { status: 200 })),
    );

    render(<CostRatesForm />);

    await waitFor(() => screen.getByTestId("cost-rates-cluster-0"));
    const cluster0 = screen.getByTestId("cost-rates-cluster-0") as HTMLInputElement;
    const rate0 = screen.getByTestId("cost-rates-rate-0") as HTMLInputElement;
    expect(cluster0.value).toBe("cluster-a");
    expect(rate0.value).toBe("0.5");
    const cluster1 = screen.getByTestId("cost-rates-cluster-1") as HTMLInputElement;
    expect(cluster1.value).toBe("cluster-b");
  });

  test("editing a rate + Save PUTs the updated costRates and preserves softWeights", async () => {
    const spec: PreferenceSpec = {
      softWeights: {
        loadWeight: 1,
        costWeight: 2,
        localityWeight: 1,
        queueWaitWeight: 1,
      },
      costRates: { "cluster-a": 0.5 },
    };
    let capturedBody: unknown = null;
    let capturedMethod = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const method = init?.method ?? (typeof input !== "string" ? input.method : "GET");
        if (method === "PUT") {
          capturedMethod = "PUT";
          capturedBody = JSON.parse((init?.body as string) ?? "{}");
          const returned: PreferenceSpec = {
            ...spec,
            costRates: { "cluster-a": 0.9 },
          };
          return new Response(JSON.stringify({ spec: returned }), { status: 200 });
        }
        return new Response(JSON.stringify({ spec }), { status: 200 });
      }),
    );

    render(<CostRatesForm />);
    await waitFor(() => screen.getByTestId("cost-rates-rate-0"));

    fireEvent.change(screen.getByTestId("cost-rates-rate-0"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByTestId("cost-rates-save"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(capturedMethod).toBe("PUT");
    expect(capturedBody).toMatchObject({
      costRates: { "cluster-a": 0.9 },
      softWeights: {
        loadWeight: 1,
        costWeight: 2,
        localityWeight: 1,
        queueWaitWeight: 1,
      },
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  test("a negative/NaN rate triggers toast.error and issues no PUT", async () => {
    const spec: PreferenceSpec = {
      costRates: { "cluster-a": 0.5 },
    };
    let putCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const method = init?.method ?? (typeof input !== "string" ? input.method : "GET");
        if (method === "PUT") {
          putCount += 1;
          return new Response(JSON.stringify({ spec }), { status: 200 });
        }
        return new Response(JSON.stringify({ spec }), { status: 200 });
      }),
    );

    render(<CostRatesForm />);
    await waitFor(() => screen.getByTestId("cost-rates-rate-0"));

    fireEvent.change(screen.getByTestId("cost-rates-rate-0"), { target: { value: "-3" } });
    fireEvent.click(screen.getByTestId("cost-rates-save"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(putCount).toBe(0);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test("load failure renders error card and hides write actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
            status: 403,
          }),
      ),
    );

    render(<CostRatesForm />);
    await waitFor(() => screen.getByTestId("cost-rates-load-error"));

    const error = screen.getByTestId("cost-rates-load-error");
    expect(error.textContent).toMatch(/没有执行此操作的权限|does not have permission/);
    expect(error.textContent).not.toContain("denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByTestId("cost-rates-save")).toBeNull();
    expect(screen.queryByTestId("cost-rates-add")).toBeNull();
  });
});
