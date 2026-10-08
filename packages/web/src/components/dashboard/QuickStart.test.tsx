import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { parseWorkflowYaml } from "../../lib/workflow-parser";
import { QuickStart } from "./QuickStart";

const { post, navigate } = vi.hoisted(() => ({ post: vi.fn(), navigate: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api: { post } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

test("the starter workflow is valid without installed software and opens its run", async () => {
  post.mockResolvedValue({ runId: "example-run", status: "submitted" });
  render(<QuickStart />);
  fireEvent.click(screen.getByTestId("quick-start-submit-workflow"));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$runId",
      params: { runId: "example-run" },
    }),
  );
  const [path, body] = post.mock.calls[0] as [string, { yaml: string }];
  expect(path).toBe("/workflows");
  const parsed = parseWorkflowYaml(body.yaml);
  if (!parsed.ok) throw new Error(parsed.message);
  const { workflow } = parsed;
  expect(workflow.spec.nodeDrafts).toHaveLength(2);
  expect(workflow.spec.nodeDrafts.every((node) => node.type === "NoAction")).toBe(true);
  expect(workflow.spec.nodeRelations).toEqual([
    { fromId: "start", toId: "done", slotRelations: [] },
  ]);
});

test("a submitted example job opens the returned job detail", async () => {
  post.mockResolvedValue({ id: "example-job", name: "demo-hello", status: "pending" });
  render(<QuickStart />);
  fireEvent.click(screen.getByTestId("quick-start-submit-job"));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/jobs/$jobId",
      params: { jobId: "example-job" },
    }),
  );
});

test("a failed submission keeps the user on the page and allows retry", async () => {
  post.mockRejectedValue(new Error("Unavailable"));
  render(<QuickStart />);
  const button = screen.getByTestId("quick-start-submit-workflow");
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(navigate).not.toHaveBeenCalled();
});
