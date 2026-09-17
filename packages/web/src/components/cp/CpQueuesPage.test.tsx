import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { CpQueuesPage } from "./CpQueuesPage";

function queueListResponse(queues: unknown[], status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify({ queues }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function errorResponse(code: string, message: string, status = 403) {
  return Promise.resolve(
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function inventoryResponse(
  agentId: string,
  schedulerType: "slurm" | "pbs-pro" | "torque" | "kubernetes",
  queueName: string,
  managed = false,
) {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        agentId,
        providerOrgId: "11111111-1111-4111-8111-111111111111",
        schedulerType,
        queueInventoryV1: true,
        status: "available",
        defaultQueueName: queueName,
        reason: null,
        observedAt: "2026-08-19T00:00:00.000Z",
        lastAttemptAt: "2026-08-19T00:00:00.000Z",
        lastSuccessfulObservedAt: "2026-08-19T00:00:00.000Z",
        freshUntil: "2026-08-19T00:02:00.000Z",
        queues: [
          {
            queueName,
            queueType: "partition",
            isDefault: true,
            state: "up",
            acceptsSubmissions: true,
            observedAt: "2026-08-19T00:00:00.000Z",
            managed,
            managedQueueIds: managed ? ["queue-1"] : [],
          },
        ],
        managedTargets: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function queueInventoryResponse(payload: Record<string, unknown>) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function managedQueue(input: {
  queueId: string;
  agentId: string;
  schedulerType: "slurm" | "pbs-pro" | "torque" | "kubernetes";
  targetMode: "default" | "named";
  queueName?: string;
}) {
  return {
    queueId: input.queueId,
    name: input.queueId,
    providerOrgId: "11111111-1111-4111-8111-111111111111",
    visibleOrgIds: [],
    agentId: input.agentId,
    schedulerType: input.schedulerType,
    queueName: input.targetMode === "named" ? (input.queueName ?? "queue") : null,
    target: { mode: input.targetMode },
    qos: null,
    enabled: true,
    policyTags: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function makeClientWrapper() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function makeWrapper() {
  return makeClientWrapper().wrapper;
}

function installFetch() {
  const queue = {
    queueId: "queue-1",
    name: "CPU normal",
    providerOrgId: "11111111-1111-4111-8111-111111111111",
    visibleOrgIds: ["22222222-2222-4222-8222-222222222222"],
    agentId: "agent-slurm",
    schedulerType: "slurm",
    queueName: "normal",
    qos: null,
    enabled: true,
    policyTags: ["cpu"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/platform/api/admin/queues" && method === "GET") {
      return queueListResponse([queue]);
    }
    if (url === "/platform/api/cp/agents" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              { id: "agent-slurm", hostname: "slurm", siteId: "site-a", status: "online" },
              { id: "agent-gpu", hostname: "gpu", siteId: "site-b", status: "online" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            providerOrgs: [
              { id: "11111111-1111-4111-8111-111111111111", name: "Provider" },
              { id: "33333333-3333-4333-8333-333333333333", name: "Consumer" },
            ],
            isPlatformWide: false,
            schedulers: ["slurm", "pbs-pro"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/admin/agents/agent-slurm/queue-inventory" && method === "GET") {
      return inventoryResponse("agent-slurm", "slurm", "normal", true);
    }
    if (url === "/platform/api/admin/agents/agent-gpu/queue-inventory" && method === "GET") {
      return inventoryResponse("agent-gpu", "pbs-pro", "gpu");
    }
    if (url === "/platform/api/admin/queues" && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...queue,
            queueId: "queue-gpu",
            name: "GPU batch",
            agentId: "agent-gpu",
            schedulerType: "pbs-pro",
            queueName: "gpu",
            qos: "gold",
            enabled: true,
            policyTags: ["gpu", "paid"],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url === "/platform/api/admin/queues/queue-1" && method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify({ ...queue, enabled: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CpQueuesPage", () => {
  test("shows an empty state when the provider has no queues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/platform/api/admin/queues" && method === "GET") {
          return queueListResponse([]);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queues-empty"));
    expect(screen.getByText("cp.queues.empty")).toBeTruthy();
    expect(screen.queryByTestId("cp-queues-error")).toBeNull();
  });

  test("surfaces provider-scope authorization failures instead of showing an empty table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/platform/api/admin/queues" && method === "GET") {
          return errorResponse("FORBIDDEN", "provider scope denied");
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queues-error"));
    const error = screen.getByTestId("cp-queues-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("provider scope denied");
    expect(screen.queryByTestId("cp-queues-empty")).toBeNull();
    expect(screen.getByTestId("cp-queues-create")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("cp-queues-create"));
    expect(screen.queryByTestId("cp-queue-submit")).toBeNull();
  });

  test("clears stale queue actions after a list refetch error", async () => {
    const queue = {
      queueId: "queue-1",
      name: "CPU normal",
      providerOrgId: "11111111-1111-4111-8111-111111111111",
      visibleOrgIds: ["22222222-2222-4222-8222-222222222222"],
      agentId: "agent-slurm",
      schedulerType: "slurm",
      queueName: "normal",
      qos: null,
      enabled: true,
      policyTags: ["cpu"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/admin/queues" && method === "GET") {
        listCalls += 1;
        return listCalls === 1
          ? queueListResponse([queue])
          : errorResponse("FORBIDDEN", "provider scope denied");
      }
      if (url === "/platform/api/admin/queues" && method === "POST") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      if (url === "/platform/api/admin/queues/queue-1" && method === "PATCH") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { qc, wrapper } = makeClientWrapper();

    render(<CpQueuesPage />, { wrapper });

    await waitFor(() => screen.getByTestId("cp-queue-row-queue-1"));
    fireEvent.click(screen.getByTestId("cp-queue-edit-queue-1"));
    expect(screen.getByTestId("cp-queue-submit")).toBeTruthy();

    await qc.invalidateQueries({ queryKey: ["cp", "queues"] });

    await waitFor(() => screen.getByTestId("cp-queues-error"));
    const error = screen.getByTestId("cp-queues-error");
    expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
    expect(error.textContent).not.toContain("provider scope denied");
    expect(screen.queryByTestId("cp-queue-row-queue-1")).toBeNull();
    expect(screen.queryByTestId("cp-queue-toggle-queue-1")).toBeNull();
    expect(screen.queryByTestId("cp-queue-submit")).toBeNull();
    expect(screen.getByTestId("cp-queues-create")).toHaveProperty("disabled", true);
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          (url === "/platform/api/admin/queues" && init?.method === "POST") ||
          (url === "/platform/api/admin/queues/queue-1" && init?.method === "PATCH")
        );
      }),
    ).toBe(false);
  });

  test("renders registered queues and disables one with PATCH", async () => {
    const fetchMock = installFetch();
    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queue-row-queue-1"));
    expect(screen.getByText("CPU normal")).toBeTruthy();
    const scroller = screen.getByTestId("cp-queues-table-scroll");
    expect(scroller.className).toContain("sm:overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("sm:min-w-[76rem]");
    const row = screen.getByTestId("cp-queue-row-queue-1");
    expect(row.className).toContain("grid");
    expect(screen.getByTestId("cp-queue-edit-queue-1").className).toContain("min-h-11");
    const details = screen.getByTestId("cp-queue-details-queue-1");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(details.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(details.getAttribute("aria-controls")).toBe("cp-queue-detail-queue-1");
    expect(document.getElementById("cp-queue-detail-queue-1")?.textContent).toContain("queue-1");
    fireEvent.click(screen.getByTestId("cp-queue-toggle-queue-1"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.queues.toast.disabled"));
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url === "/platform/api/admin/queues/queue-1" &&
          init?.method === "PATCH" &&
          init.body === JSON.stringify({ enabled: false })
        );
      }),
    ).toBe(true);
  });

  test("tracks concurrent queue toggles independently", async () => {
    const queues = [
      {
        queueId: "queue-a",
        name: "Queue A",
        providerOrgId: "11111111-1111-4111-8111-111111111111",
        visibleOrgIds: [],
        agentId: "agent-slurm",
        schedulerType: "slurm",
        queueName: "a",
        qos: null,
        enabled: true,
        policyTags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        queueId: "queue-b",
        name: "Queue B",
        providerOrgId: "11111111-1111-4111-8111-111111111111",
        visibleOrgIds: [],
        agentId: "agent-slurm",
        schedulerType: "slurm",
        queueName: "b",
        qos: null,
        enabled: true,
        policyTags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    let resolveA: ((response: Response) => void) | undefined;
    let resolveB: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/platform/api/admin/queues" && method === "GET") {
          return queueListResponse(queues);
        }
        if (url === "/platform/api/cp/agents" && method === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify({ providerOrgs: [], schedulers: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url === "/platform/api/admin/queues/queue-a" && method === "PATCH") {
          return new Promise<Response>((resolve) => {
            resolveA = resolve;
          });
        }
        if (url === "/platform/api/admin/queues/queue-b" && method === "PATCH") {
          return new Promise<Response>((resolve) => {
            resolveB = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );
    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queue-row-queue-a"));
    const toggleA = screen.getByTestId("cp-queue-toggle-queue-a");
    const toggleB = screen.getByTestId("cp-queue-toggle-queue-b");
    fireEvent.click(toggleA);
    fireEvent.click(toggleB);
    await waitFor(() => {
      expect(toggleA).toHaveProperty("disabled", true);
      expect(toggleB).toHaveProperty("disabled", true);
    });

    resolveA?.(new Response(JSON.stringify({ ...queues[0], enabled: false }), { status: 200 }));
    await waitFor(() => expect(toggleA).toHaveProperty("disabled", false));
    expect(toggleB).toHaveProperty("disabled", true);

    resolveB?.(new Response(JSON.stringify({ ...queues[1], enabled: false }), { status: 200 }));
    await waitFor(() => expect(toggleB).toHaveProperty("disabled", false));
  });

  test("creates a queue from dialog fields", async () => {
    const fetchMock = installFetch();
    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queue-row-queue-1"));
    fireEvent.click(screen.getByTestId("cp-queues-create"));
    fireEvent.change(screen.getByTestId("cp-queue-field-queue-id"), {
      target: { value: "queue-gpu" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-name"), {
      target: { value: "GPU batch" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-agent-id"), {
      target: { value: "agent-gpu" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("cp-queue-field-scheduler-type").textContent).toBe("pbs-pro"),
    );
    fireEvent.change(screen.getByTestId("cp-queue-field-queue-name"), {
      target: { value: "gpu" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-qos"), {
      target: { value: "gold" },
    });
    fireEvent.click(screen.getByLabelText("Consumer"));
    fireEvent.change(screen.getByTestId("cp-queue-field-policy-tags"), {
      target: { value: "gpu, paid" },
    });
    fireEvent.click(screen.getByTestId("cp-queue-submit"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.queues.toast.created"));
    const post = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url === "/platform/api/admin/queues" && init?.method === "POST";
    });
    expect(post).toBeDefined();
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      queueId: "queue-gpu",
      name: "GPU batch",
      providerOrgId: "11111111-1111-4111-8111-111111111111",
      visibleOrgIds: ["33333333-3333-4333-8333-333333333333"],
      agentId: "agent-gpu",
      schedulerType: "pbs-pro",
      target: { mode: "named" },
      queueName: "gpu",
      qos: "gold",
      enabled: true,
      policyTags: ["gpu", "paid"],
    });
  });

  test("keeps OpenPBS and Torque discovered-but-unmanaged facts separate from managed defaults", async () => {
    const freshUntil = new Date(Date.now() + 60_000).toISOString();
    const queues = [
      managedQueue({
        queueId: "pbs-default",
        agentId: "agent-pbs",
        schedulerType: "pbs-pro",
        targetMode: "default",
      }),
      managedQueue({
        queueId: "torque-default",
        agentId: "agent-torque",
        schedulerType: "torque",
        targetMode: "default",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/platform/api/admin/queues" && method === "GET") {
          return queueListResponse(queues);
        }
        if (url === "/platform/api/cp/agents" && method === "GET") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  { id: "agent-pbs", hostname: "pbs", siteId: "site-pbs", status: "online" },
                  {
                    id: "agent-torque",
                    hostname: "torque",
                    siteId: "site-torque",
                    status: "online",
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify({ providerOrgs: [], schedulers: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url === "/platform/api/admin/agents/agent-pbs/queue-inventory" && method === "GET") {
          return queueInventoryResponse({
            agentId: "agent-pbs",
            providerOrgId: "11111111-1111-4111-8111-111111111111",
            schedulerType: "pbs-pro",
            queueInventoryV1: true,
            status: "available",
            defaultQueueName: "pbs23-workq",
            reason: null,
            observedAt: "2026-08-19T00:00:00.000Z",
            lastAttemptAt: "2026-08-19T00:00:00.000Z",
            lastSuccessfulObservedAt: "2026-08-19T00:00:00.000Z",
            freshUntil,
            queues: [
              {
                queueName: "pbs23-workq",
                queueType: "execution",
                isDefault: true,
                state: "up",
                acceptsSubmissions: true,
                observedAt: "2026-08-19T00:00:00.000Z",
                managed: true,
                managedQueueIds: ["pbs-default"],
              },
              {
                queueName: "workq",
                queueType: "execution",
                isDefault: false,
                state: "up",
                acceptsSubmissions: true,
                observedAt: "2026-08-19T00:00:00.000Z",
                managed: false,
                managedQueueIds: [],
              },
            ],
            managedTargets: [],
          });
        }
        if (url === "/platform/api/admin/agents/agent-torque/queue-inventory" && method === "GET") {
          return queueInventoryResponse({
            agentId: "agent-torque",
            providerOrgId: "11111111-1111-4111-8111-111111111111",
            schedulerType: "torque",
            queueInventoryV1: true,
            status: "available",
            defaultQueueName: "torque6-batch",
            reason: null,
            observedAt: "2026-08-19T00:00:00.000Z",
            lastAttemptAt: "2026-08-19T00:00:00.000Z",
            lastSuccessfulObservedAt: "2026-08-19T00:00:00.000Z",
            freshUntil,
            queues: [
              {
                queueName: "torque6-batch",
                queueType: "execution",
                isDefault: true,
                state: "up",
                acceptsSubmissions: true,
                observedAt: "2026-08-19T00:00:00.000Z",
                managed: true,
                managedQueueIds: ["torque-default"],
              },
              {
                queueName: "batch",
                queueType: "execution",
                isDefault: false,
                state: "up",
                acceptsSubmissions: true,
                observedAt: "2026-08-19T00:00:00.000Z",
                managed: false,
                managedQueueIds: [],
              },
            ],
            managedTargets: [],
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    render(<CpQueuesPage />, { wrapper: makeWrapper() });
    const inventoryTab = await screen.findByTestId("cp-queues-tab-inventory");
    fireEvent.mouseDown(inventoryTab, { button: 0, ctrlKey: false });

    const pbs = await screen.findByTestId("cp-queue-inventory-agent-agent-pbs");
    const torque = await screen.findByTestId("cp-queue-inventory-agent-agent-torque");
    expect(pbs.textContent).toContain("pbs23-workq");
    expect(pbs.textContent).toContain("workq");
    expect(pbs.textContent).toContain("cp.queues.managed");
    expect(pbs.textContent).toContain("cp.queues.unmanaged");
    expect(torque.textContent).toContain("torque6-batch");
    expect(torque.textContent).toContain("batch");
    expect(torque.textContent).toContain("cp.queues.unmanaged");
    expect(screen.queryByText("cp.queues.inventoryLoadFailed")).toBeNull();
  });

  test("keeps stale facts and attempt timestamps visible instead of showing an empty inventory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/platform/api/admin/queues" && method === "GET") return queueListResponse([]);
        if (url === "/platform/api/cp/agents" && method === "GET") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [{ id: "agent-stale", hostname: "stale", siteId: "site", status: "online" }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify({ providerOrgs: [], schedulers: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url === "/platform/api/admin/agents/agent-stale/queue-inventory" && method === "GET") {
          return queueInventoryResponse({
            agentId: "agent-stale",
            providerOrgId: "11111111-1111-4111-8111-111111111111",
            schedulerType: "pbs-pro",
            queueInventoryV1: true,
            status: "stale",
            defaultQueueName: "pbs23-workq",
            reason: "stale",
            observedAt: "2026-08-19T00:00:00.000Z",
            lastAttemptAt: "2026-08-19T00:03:00.000Z",
            lastSuccessfulObservedAt: "2026-08-19T00:00:00.000Z",
            freshUntil: null,
            queues: [
              {
                queueName: "workq",
                queueType: "execution",
                isDefault: false,
                state: "up",
                acceptsSubmissions: true,
                observedAt: "2026-08-19T00:00:00.000Z",
                managed: false,
                managedQueueIds: [],
              },
            ],
            managedTargets: [
              {
                queueId: "missing-named",
                targetMode: "named",
                queueName: "missing",
                available: false,
                reason: "queue_not_found",
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    render(<CpQueuesPage />, { wrapper: makeWrapper() });
    const inventoryTab = await screen.findByTestId("cp-queues-tab-inventory");
    fireEvent.mouseDown(inventoryTab, { button: 0, ctrlKey: false });

    const section = await screen.findByTestId("cp-queue-inventory-agent-agent-stale");
    expect(section.textContent).toContain("cp.queues.inventoryStatus.stale");
    expect(section.textContent).toContain("cp.queues.lastAttempt");
    expect(section.textContent).toContain("cp.queues.lastSuccessfulObserved");
    expect(section.textContent).toContain("workq");
    expect(section.textContent).toContain("missing-named");
    expect(section.textContent).toContain("cp.queues.notDiscovered");
    expect(screen.getByTestId("cp-queue-manage-agent-stale-workq")).toBeTruthy();
    expect(screen.queryByTestId("cp-queue-inventory-empty-agent-stale")).toBeNull();
  });

  test("prebuilds a stale last-known named fact disabled and does not send an enabled target", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/admin/queues" && method === "GET") return queueListResponse([]);
      if (url === "/platform/api/cp/agents" && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: "agent-stale", hostname: "stale", siteId: "site", status: "online" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              providerOrgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Provider" }],
              schedulers: ["pbs-pro"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/platform/api/admin/agents/agent-stale/queue-inventory" && method === "GET") {
        return queueInventoryResponse({
          agentId: "agent-stale",
          providerOrgId: "11111111-1111-4111-8111-111111111111",
          schedulerType: "pbs-pro",
          queueInventoryV1: true,
          status: "stale",
          defaultQueueName: "pbs23-workq",
          reason: "stale",
          observedAt: "2026-08-19T00:00:00.000Z",
          lastAttemptAt: "2026-08-19T00:03:00.000Z",
          lastSuccessfulObservedAt: "2026-08-19T00:00:00.000Z",
          freshUntil: null,
          queues: [
            {
              queueName: "workq",
              queueType: "execution",
              isDefault: false,
              state: "up",
              acceptsSubmissions: true,
              observedAt: "2026-08-19T00:00:00.000Z",
              managed: false,
              managedQueueIds: [],
            },
          ],
          managedTargets: [],
        });
      }
      if (url === "/platform/api/admin/queues" && method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ queueId: "queue-stale" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CpQueuesPage />, { wrapper: makeWrapper() });
    await waitFor(() => screen.getByTestId("cp-queues-create"));
    fireEvent.click(screen.getByTestId("cp-queues-create"));
    fireEvent.change(screen.getByTestId("cp-queue-field-queue-id"), {
      target: { value: "queue-stale" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-name"), {
      target: { value: "Stale workq" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-agent-id"), {
      target: { value: "agent-stale" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("cp-queue-field-queue-name")).toHaveProperty("disabled", false),
    );
    fireEvent.change(screen.getByTestId("cp-queue-field-queue-name"), {
      target: { value: "workq" },
    });

    expect(screen.getByTestId("cp-queue-field-enabled")).toHaveProperty("checked", false);
    expect(screen.getByTestId("cp-queue-field-enabled")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("cp-queue-submit"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.queues.toast.created"));
    const post = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url === "/platform/api/admin/queues" && init?.method === "POST";
    });
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
      target: { mode: "named" },
      queueName: "workq",
      enabled: false,
    });
  });

  test("manages a fresh scheduler default fact without sending queueName", async () => {
    const fetchMock = installFetch();
    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    const inventoryTab = await screen.findByTestId("cp-queues-tab-inventory");
    fireEvent.mouseDown(inventoryTab, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId("cp-queue-manage-agent-gpu-gpu"));
    fireEvent.change(screen.getByTestId("cp-queue-field-queue-id"), {
      target: { value: "queue-pbs-default" },
    });
    fireEvent.change(screen.getByTestId("cp-queue-field-name"), {
      target: { value: "PBS scheduler default" },
    });
    expect(screen.getByTestId("cp-queue-target-default")).toHaveProperty("checked", true);
    expect(screen.queryByTestId("cp-queue-field-queue-name")).toBeNull();
    fireEvent.click(screen.getByTestId("cp-queue-submit"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.queues.toast.created"));
    const post = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url === "/platform/api/admin/queues" && init?.method === "POST";
    });
    const payload = JSON.parse((post?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(payload.target).toEqual({ mode: "default" });
    expect(payload).not.toHaveProperty("queueName");
    expect(payload.schedulerType).toBe("pbs-pro");
  });

  test("does not turn a default target into an empty named queue while editing", async () => {
    const queue = {
      queueId: "queue-default",
      name: "Scheduler default",
      providerOrgId: "11111111-1111-4111-8111-111111111111",
      visibleOrgIds: [],
      agentId: "agent-slurm",
      schedulerType: "slurm",
      queueName: null,
      target: { mode: "default" },
      qos: null,
      enabled: true,
      policyTags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/platform/api/admin/queues" && method === "GET") {
        return queueListResponse([queue]);
      }
      if (url === "/platform/api/cp/agents" && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: "agent-slurm",
                  hostname: "slurm",
                  siteId: "site-a",
                  status: "online",
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url === "/platform/api/cp/agent-registration-context" && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ providerOrgs: [], schedulers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url === "/platform/api/admin/agents/agent-slurm/queue-inventory" && method === "GET") {
        return inventoryResponse("agent-slurm", "slurm", "batch", true);
      }
      if (url === "/platform/api/admin/queues/queue-default" && method === "PATCH") {
        return Promise.resolve(
          new Response(JSON.stringify(queue), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CpQueuesPage />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByTestId("cp-queue-row-queue-default"));
    fireEvent.click(screen.getByTestId("cp-queue-edit-queue-default"));
    expect(screen.queryByTestId("cp-queue-field-queue-name")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("cp-queue-field-scheduler-type").textContent).toBe("slurm"),
    );
    fireEvent.click(screen.getByTestId("cp-queue-submit"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("cp.queues.toast.updated"));
    const patch = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url === "/platform/api/admin/queues/queue-default" && init?.method === "PATCH";
    });
    expect(patch).toBeDefined();
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).not.toHaveProperty("queueName");
  });
});
