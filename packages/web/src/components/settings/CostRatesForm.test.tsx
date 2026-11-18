import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { nativeControl } from "../../lib/test-resource-field";
import { CostRatesForm } from "./CostRatesForm";

const provider = "44444444-4444-4444-8444-444444444444";
const cluster = "11111111-1111-4111-8111-111111111111";
const directory = {
  clusters: [
    { id: cluster, organizationName: "Provider A", zoneName: "Zone B", clusterName: "Cluster C" },
  ],
  rates: {},
  legacyRates: { "legacy-cluster": 4 },
};

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

test.each([
  undefined,
  provider,
])("selects a cluster by its hierarchical label and saves its ID in the correct scope (%s)", async (organizationId) => {
  api.get.mockResolvedValue(directory);
  api.put.mockResolvedValue({ ...directory, rates: { [cluster]: 0.9 } });

  render(<CostRatesForm organizationId={organizationId} />);
  fireEvent.click(await screen.findByTestId("cost-rates-add"));
  expect(screen.getByText("Provider A – Zone B – Cluster C")).toBeTruthy();
  fireEvent.change(nativeControl(screen.getByTestId("cost-rates-cluster-0")), {
    target: { value: cluster },
  });
  fireEvent.change(screen.getByTestId("cost-rates-rate-0"), { target: { value: "0.9" } });
  fireEvent.click(screen.getByTestId("cost-rates-save"));

  const path = organizationId
    ? `/preferences/org/${organizationId}/cost-rates`
    : "/preferences/global/cost-rates";
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      path,
      { [cluster]: 0.9 },
      organizationId ? expect.objectContaining({ organizationId }) : undefined,
    ),
  );
  expect(api.get).toHaveBeenCalledWith(path);
});

test.each([
  "",
  " ",
  "-1",
  "Infinity",
])("invalid rate %j is not submitted as zero; explicit zero is valid", async (value) => {
  api.get.mockResolvedValue({ ...directory, rates: { [cluster]: 0.5 } });
  api.put.mockResolvedValue({ ...directory, rates: { [cluster]: 0 } });
  render(<CostRatesForm />);
  const input = await screen.findByTestId("cost-rates-rate-0");
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByTestId("cost-rates-save"));
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(screen.getByTestId("cost-rates-save"));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      "/preferences/global/cost-rates",
      { [cluster]: 0 },
      undefined,
    ),
  );
});

test("load failure hides write actions", async () => {
  api.get.mockRejectedValue({ status: 403, code: "FORBIDDEN", message: "denied" });
  render(<CostRatesForm />);
  await screen.findByTestId("cost-rates-load-error");
  expect(screen.queryByTestId("cost-rates-save")).toBeNull();
  expect(screen.queryByTestId("cost-rates-add")).toBeNull();
});
