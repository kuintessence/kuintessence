import type { FederationCapability } from "@kuintessence/shared/federation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { materialDigest } from "./asset-material";
import { FederationAssetsPanel } from "./FederationAssetsPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = uuid(1),
  site = uuid(2);
const scope = { organizationId: org, authRevision: "fixture" };
const content = {
  protocolVersion: 1,
  kind: "inputs",
  parameters: { iterations: 2 },
  datasets: [],
  bindings: [],
};
const digest = await materialDigest(content);
const mapping = {
  id: uuid(3),
  localOrgId: org,
  originSiteId: site,
  kind: "dataset",
  originId: uuid(4),
  originRevision: "1",
  digest,
  softwareRevisionId: null,
  dataVersionId: uuid(5),
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null as string | null,
};
let grants: FederationCapability[],
  materialRows: {
    localOrgId: string;
    originSiteId: string;
    originName?: string | null;
    digest: string;
    kind: string;
    createdAt: string;
  }[],
  mappingRows: (typeof mapping)[];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FederationAssetsPanel scope={scope} switching={false} />
    </QueryClientProvider>,
  );
  return client;
}
function mappingsTab() {
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Asset mappings" }), {
    button: 0,
    ctrlKey: false,
  });
}
async function prepareMaterial() {
  fireEvent.click(await screen.findByRole("button", { name: "Import material" }));
  fireEvent.change(screen.getByLabelText("Origin site"), { target: { value: site } });
  fireEvent.change(screen.getByLabelText("Original material"), {
    target: { value: JSON.stringify(content) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  return screen.findByRole("dialog");
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  grants = ["asset.read", "asset.map"];
  materialRows = [];
  mappingRows = [mapping];
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/federation/capabilities")
      return { data: { orgId: org, userId: uuid(9), grants, effectiveCapabilities: grants } };
    if (path.includes("/materials?")) return { data: { data: materialRows, hasMore: false } };
    if (path.includes("/mappings?")) return { data: mappingRows };
    if (path.includes("/materials/")) return { data: content };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path.endsWith("/materials")) return { data: { digest, kind: content.kind } };
    if (path.endsWith("/mappings")) return { data: mapping };
    if (path.endsWith("/revoke")) {
      mappingRows = [{ ...mapping, revokedAt: "2026-01-02T00:00:00.000Z" }];
      return { success: true };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
});

test("imports immutable material only after independent confirmation and invalidates task options", async () => {
  const client = mount();
  client.setQueryData(["federation", "task-options", org, "fixture", "materials", 0], "old");
  const dialog = await prepareMaterial();
  expect(within(dialog).getByText(digest)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Saved.");
  expect(api.post).toHaveBeenCalledExactlyOnceWith(
    "/federation/assets/materials",
    { originSiteId: site, content },
    scope,
  );
  expect(
    client.getQueryState(["federation", "task-options", org, "fixture", "materials", 0])
      ?.isInvalidated,
  ).toBe(true);
});

test("unknown material responses retain the original payload for retry", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "fixture"));
  mount();
  const dialog = await prepareMaterial();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  const retry = await within(dialog).findByRole("button", {
    name: "Retry original request",
  });
  const first = vi.mocked(api.post).mock.calls[0];
  fireEvent.click(retry);
  await screen.findByText("Saved.");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(first);
});

test("revoked mapping permission closes an open confirmation and disables writes", async () => {
  const client = mount();
  await prepareMaterial();
  act(() => {
    client.setQueryData(["federation", "current-capabilities", org, "fixture"], {
      orgId: org,
      userId: uuid(9),
      grants: ["asset.read"],
      effectiveCapabilities: ["asset.read"],
    });
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Import material" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("an unconfirmed revocation response retains and retries the original mapping", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({ success: false });
  mount();
  await screen.findByRole("button", { name: "Import material" });
  mappingsTab();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke mapping" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await within(dialog).findByRole("button", { name: "Retry original request" });
  expect(screen.queryByText("Saved.")).toBeNull();
  const original = vi.mocked(api.post).mock.calls[0];
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry original request" }));
  await screen.findByText("Revoked");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(original);
});

test("registers exact dataset and local version mapping, then revokes it independently", async () => {
  mount();
  await screen.findByRole("button", { name: "Import material" });
  mappingsTab();
  fireEvent.click(await screen.findByRole("button", { name: "Register mapping" }));
  for (const [label, value] of [
    ["Origin site", site],
    ["Origin asset ID", mapping.originId],
    ["Origin revision", "1"],
    ["SHA-256", digest],
    ["Local immutable revision ID", mapping.dataVersionId],
  ] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "dataset" } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Saved.");
  expect(api.post).toHaveBeenCalledWith(
    "/federation/assets/mappings",
    {
      reference: {
        originSiteId: site,
        kind: "dataset",
        id: mapping.originId,
        revision: "1",
        digest,
      },
      localRevisionId: mapping.dataVersionId,
    },
    scope,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Revoke mapping" }));
  const revoke = await screen.findByRole("dialog");
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(within(revoke).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Revoked");
  expect(api.post).toHaveBeenLastCalledWith(
    `/federation/assets/mappings/${mapping.id}/revoke`,
    {},
    scope,
  );
});

test("read-only viewers inspect verified content but cannot import or revoke", async () => {
  grants = ["asset.read"];
  materialRows = [
    { localOrgId: org, originSiteId: site, digest, kind: "inputs", createdAt: mapping.createdAt },
  ];
  mount();
  const row = await screen.findByRole("button", { name: new RegExp(digest.slice(0, 19)) });
  expect(screen.queryByRole("button", { name: "Import material" })).toBeNull();
  fireEvent.click(row);
  await screen.findByRole("button", { name: "Export material" });
  expect(screen.getByText("Parameters")).toBeTruthy();
  expect(screen.getByText("Site name unavailable")).toBeTruthy();
  expect(screen.getByText(site)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to materials" }));
  mappingsTab();
  await screen.findByText("Active");
  expect(screen.queryByRole("button", { name: "Revoke mapping" })).toBeNull();
});

test("refuses modified material contents and wrong-organization lists", async () => {
  materialRows = [
    { localOrgId: org, originSiteId: site, digest, kind: "inputs", createdAt: mapping.createdAt },
  ];
  const get = vi.mocked(api.get).getMockImplementation();
  vi.mocked(api.get).mockImplementation(async (path, ...args) =>
    path.includes("/materials/")
      ? { data: { ...content, parameters: { altered: true } } }
      : get?.(path, ...args),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(digest.slice(0, 19)) }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Export material" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to materials" }));
  mappingRows = [{ ...mapping, localOrgId: uuid(88) }];
  mappingsTab();
  await screen.findByRole("alert");
  expect(screen.queryByText(mapping.originId)).toBeNull();
});

test("rejects invalid or excessively nested material before writing", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Import material" }));
  fireEvent.change(screen.getByLabelText("Origin site"), { target: { value: site } });
  const nested = `${"[".repeat(40)}0${"]".repeat(40)}`;
  for (const json of [
    "not JSON",
    nested,
    JSON.stringify({ ...content, extraField: "unrecognized" }),
  ]) {
    fireEvent.change(screen.getByLabelText("Original material"), { target: { value: json } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("fails closed if the server returns another material digest", async () => {
  vi.mocked(api.post).mockResolvedValue({
    data: { digest: `sha256:${"b".repeat(64)}`, kind: "inputs" },
  });
  mount();
  const dialog = await prepareMaterial();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await within(dialog).findByRole("alert");
  expect(screen.queryByText("Saved.")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Retry original request" })).toBeTruthy();
});

test("reviews an environment lock with its real target and exact native lock reference", async () => {
  const lock = {
    protocolVersion: 1,
    kind: "environment-lock",
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: `sha256:${"c".repeat(64)}`,
    software: [],
  };
  const lockDigest = await materialDigest(lock);
  vi.mocked(api.post).mockResolvedValue({ data: { digest: lockDigest, kind: lock.kind } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Import material" }));
  fireEvent.change(screen.getByLabelText("Origin site"), { target: { value: site } });
  fireEvent.change(screen.getByLabelText("Original material"), {
    target: { value: JSON.stringify(lock) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("linux / x86_64")).toBeTruthy();
  expect(within(dialog).getByText(lock.nativeLockDigest)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Saved.");
  expect(api.post).toHaveBeenCalledWith(
    "/federation/assets/materials",
    { originSiteId: site, content: lock },
    scope,
  );
});

test("a file finishing after permission revocation cannot restore a writable draft", async () => {
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Import material" }));
  let resolveFile: (text: string) => void = () => {};
  const file = new File(["fixture"], "inputs.json", { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: () =>
      new Promise<string>((resolve) => {
        resolveFile = resolve;
      }),
  });
  fireEvent.change(screen.getByLabelText("JSON file"), { target: { files: [file] } });
  act(() => {
    client.setQueryData(["federation", "current-capabilities", org, "fixture"], {
      orgId: org,
      userId: uuid(9),
      grants: ["asset.read"],
      effectiveCapabilities: ["asset.read"],
    });
  });
  await waitFor(() => expect(screen.queryByLabelText("Original material")).toBeNull());
  await act(async () => {
    resolveFile(JSON.stringify(content));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("material source shows the institution name and full ID without changing verified content", async () => {
  materialRows = [
    {
      localOrgId: org,
      originSiteId: site,
      originName: "North Research",
      digest,
      kind: "inputs",
      createdAt: mapping.createdAt,
    },
  ];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(digest.slice(0, 19)) }));
  await screen.findByRole("button", { name: "Export material" });
  expect(screen.getByText("North Research")).toBeTruthy();
  expect(screen.getByText(site)).toBeTruthy();
  expect(screen.queryByText("Site name unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});

test("an initial material read failure can recover without a permanent refresh toolbar", async () => {
  const get = vi.mocked(api.get).getMockImplementation();
  let failing = true;
  vi.mocked(api.get).mockImplementation(async (path, ...args) => {
    if (path.includes("/materials?") && failing) throw new ApiError(503, "UNAVAILABLE", "offline");
    return get?.(path, ...args);
  });
  mount();
  await screen.findByRole("alert");
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("No input snapshots or environment locks.");
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});
