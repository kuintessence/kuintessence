import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlacementPreviewPanel } from "./PlacementPreviewPanel";

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function renderPanel(getJobSpec: () => Promise<null>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PlacementPreviewPanel getJobSpec={getJobSpec} />
    </QueryClientProvider>,
  );
}
test("checks only on demand and catches failures while preparing the draft", async () => {
  const getJobSpec = vi.fn().mockRejectedValue(new Error("Failed to prepare draft"));
  renderPanel(getJobSpec);
  expect(getJobSpec).not.toHaveBeenCalled();
  expect(screen.queryByTestId("placement-pipeline")).toBeNull();
  fireEvent.click(screen.getByTestId("placement-preview-refresh"));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(getJobSpec).toHaveBeenCalledTimes(1);
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByTestId("placement-preview-refresh").hasAttribute("disabled")).toBe(false);
});
test("an incomplete draft never calls the placement endpoint", async () => {
  const getJobSpec = vi.fn().mockResolvedValue(null);
  renderPanel(getJobSpec);
  fireEvent.click(screen.getByTestId("placement-preview-refresh"));
  await waitFor(() => expect(getJobSpec).toHaveBeenCalledTimes(1));
  expect(api.post).not.toHaveBeenCalled();
});
