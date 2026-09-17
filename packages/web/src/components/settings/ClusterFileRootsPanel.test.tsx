import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClusterFileRootsPanel } from "./ClusterFileRootsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (typeof opts?.count === "number") return `${key}:${opts.count}`;
      return key;
    },
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

interface FetchCall {
  url: string;
  method: string;
  body?: BodyInit | null;
}

const rootA = {
  id: "00000000-0000-0000-0000-00000000f001",
  label: "Scratch",
  providerOrgId: "00000000-0000-0000-0000-00000000a001",
  agentId: "agent-a",
  path: "/scratch/me",
  visibleOrgIds: ["00000000-0000-0000-0000-00000000b001"],
  enabled: true,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function installFetch(handlers: Array<(call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const queue = [...handlers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: BodyInit | null; method?: string }) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const call = { url, method: init?.method ?? "GET", body: init?.body };
      calls.push(call);
      const handler = queue.shift();
      if (!handler) throw new Error(`Unexpected fetch: ${call.method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("ClusterFileRootsPanel", () => {
  test("loads existing cluster file roots", async () => {
    const calls = installFetch([() => json({ roots: [rootA] })]);

    render(<ClusterFileRootsPanel />);

    expect(await screen.findByTestId(`cluster-file-root-row-${rootA.id}`)).toBeTruthy();
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/platform/api/admin/cluster-file-roots",
    });
    expect(screen.getByTestId(`cluster-file-root-path-${rootA.id}`)).toHaveProperty(
      "value",
      "/scratch/me",
    );
  });

  test("creates a root and parses visible organization ids", async () => {
    const created = {
      ...rootA,
      id: "00000000-0000-0000-0000-00000000f002",
      label: "Project",
      agentId: null,
      path: "/project/a",
      visibleOrgIds: [
        "00000000-0000-0000-0000-00000000b001",
        "00000000-0000-0000-0000-00000000b002",
      ],
    };
    const calls = installFetch([() => json({ roots: [] }), () => json(created, 201)]);

    render(<ClusterFileRootsPanel />);

    await waitFor(() => screen.getByTestId("cluster-file-root-create-form"));
    fireEvent.change(screen.getByTestId("cluster-file-root-new-label"), {
      target: { value: "Project" },
    });
    fireEvent.change(screen.getByTestId("cluster-file-root-new-provider"), {
      target: { value: "00000000-0000-0000-0000-00000000a001" },
    });
    fireEvent.change(screen.getByTestId("cluster-file-root-new-path"), {
      target: { value: "/project/a" },
    });
    fireEvent.change(screen.getByTestId("cluster-file-root-new-visible-orgs"), {
      target: {
        value: "00000000-0000-0000-0000-00000000b001, 00000000-0000-0000-0000-00000000b002",
      },
    });
    fireEvent.submit(screen.getByTestId("cluster-file-root-create-form"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      label: "Project",
      providerOrgId: "00000000-0000-0000-0000-00000000a001",
      agentId: null,
      path: "/project/a",
      visibleOrgIds: [
        "00000000-0000-0000-0000-00000000b001",
        "00000000-0000-0000-0000-00000000b002",
      ],
      enabled: true,
    });
    expect(await screen.findByTestId(`cluster-file-root-row-${created.id}`)).toBeTruthy();
  });

  test("saves root edits with enabled state", async () => {
    const updated = { ...rootA, path: "/work/me", visibleOrgIds: [], enabled: false };
    const calls = installFetch([() => json({ roots: [rootA] }), () => json(updated)]);

    render(<ClusterFileRootsPanel />);

    await screen.findByTestId(`cluster-file-root-row-${rootA.id}`);
    fireEvent.change(screen.getByTestId(`cluster-file-root-path-${rootA.id}`), {
      target: { value: "/work/me" },
    });
    fireEvent.change(screen.getByTestId(`cluster-file-root-visible-orgs-${rootA.id}`), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(`cluster-file-root-enabled-${rootA.id}`));
    fireEvent.click(screen.getByTestId(`cluster-file-root-save-${rootA.id}`));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: `/platform/api/admin/cluster-file-roots/${rootA.id}`,
    });
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({
      path: "/work/me",
      visibleOrgIds: [],
      enabled: false,
    });
  });

  test("checks a configured root against the live agent", async () => {
    const calls = installFetch([
      () => json({ roots: [rootA] }),
      () =>
        json({
          rootId: rootA.id,
          path: rootA.path,
          agentId: rootA.agentId,
          status: "not_writable",
          checkedAt: "2026-07-08T00:00:01.000Z",
        }),
    ]);

    render(<ClusterFileRootsPanel />);

    await screen.findByTestId(`cluster-file-root-row-${rootA.id}`);
    fireEvent.click(screen.getByTestId(`cluster-file-root-check-${rootA.id}`));

    expect(await screen.findByTestId(`cluster-file-root-check-status-${rootA.id}`)).toHaveProperty(
      "textContent",
      "settings.clusterFileRoots.checkStatus.not_writable",
    );
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: `/platform/api/admin/cluster-file-roots/${rootA.id}/check`,
    });
    expect(toastSuccess).toHaveBeenCalledWith("settings.clusterFileRoots.checkComplete");
  });

  test("shows load errors instead of an empty state", async () => {
    installFetch([() => json({ error: { code: "FORBIDDEN", message: "denied" } }, 403)]);

    render(<ClusterFileRootsPanel />);

    const error = await screen.findByTestId("cluster-file-roots-error");
    expect(error.textContent).toMatch(/没有执行此操作的权限|does not have permission/);
    expect(error.textContent).not.toContain("denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByText("settings.clusterFileRoots.empty")).toBeNull();
    expect(screen.queryByTestId("cluster-file-root-create-form")).toBeNull();
  });

  test("clears stale roots and actions when refresh fails", async () => {
    installFetch([
      () => json({ roots: [rootA] }),
      () =>
        json(
          { error: { code: "FORBIDDEN", message: "Authorization principal is not bound" } },
          403,
        ),
    ]);

    render(<ClusterFileRootsPanel />);

    expect(await screen.findByTestId(`cluster-file-root-row-${rootA.id}`)).toBeTruthy();
    fireEvent.click(screen.getByText("common.refresh"));

    const error = await screen.findByTestId("cluster-file-roots-error");
    expect(error.textContent).toMatch(/没有执行此操作的权限|does not have permission/);
    expect(error.textContent).not.toContain("Authorization principal is not bound");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByTestId(`cluster-file-root-row-${rootA.id}`)).toBeNull();
    expect(screen.queryByTestId(`cluster-file-root-check-${rootA.id}`)).toBeNull();
    expect(screen.queryByTestId(`cluster-file-root-save-${rootA.id}`)).toBeNull();
    expect(screen.queryByTestId("cluster-file-root-create-form")).toBeNull();
  });
});
