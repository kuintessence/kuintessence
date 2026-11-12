import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentSiteOperations } from "./AgentSiteOperations";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(cleanup);
const report = {
  version: 1,
  observedAt: Date.now(),
  transport: "ssh-forward",
  trust: "single-user",
  executor: "slurm",
  materials: { state: "ready" },
  installation: { state: "failed" },
  jobs: { state: "blocked", active: 1 },
  transfers: { state: "failed" },
  update: { phase: "staged" },
};
test("offline snapshots show staleness, distinct channels and actionable recovery", () => {
  render(<AgentSiteOperations value={report} online={false} />);
  expect(screen.getByText("agents.operations.stale")).toBeTruthy();
  expect(screen.getByText("agents.operations.reconcileJobs")).toBeTruthy();
  expect(screen.getByText("agents.operations.resumeTransfer")).toBeTruthy();
  expect(screen.getByText("agents.operations.updates.staged")).toBeTruthy();
});
test("old agents or invalid reports are explicitly unknown", () => {
  render(<AgentSiteOperations value={null} online={true} />);
  expect(screen.getByText("agents.operations.notReported")).toBeTruthy();
});
