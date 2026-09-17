import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { JobOverviewTab } from "./JobOverviewTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { value?: number }) =>
      key === "jobs.overview.exitCode" ? `Process exit code: ${options?.value}` : key,
  }),
}));

beforeEach(() => {
  localStorage.setItem("kq.lang", "en");
});

describe("JobOverviewTab failure details", () => {
  test("shows persisted scientific diagnostics and exit code", () => {
    render(
      <JobOverviewTab
        loading={false}
        job={{
          id: "job-1",
          name: "lammps-run",
          status: "failed",
          submittedAt: "2026-08-14T00:00:00.000Z",
          errorMessage: "LAMMPS: Invalid atom style at input line 42",
          exitCode: 2,
        }}
      />,
    );

    const details = screen.getByTestId("job-error-summary");
    expect(details.textContent).toContain("LAMMPS: Invalid atom style at input line 42");
    expect(details.textContent).toContain("Process exit code: 2");
  });

  test("keeps platform authorization diagnostics out of runtime details", () => {
    render(
      <JobOverviewTab
        loading={false}
        job={{
          id: "job-2",
          name: "denied-run",
          status: "failed",
          submittedAt: "2026-08-14T00:00:00.000Z",
          errorMessage: "Authorization denied: internal tuple missing",
        }}
      />,
    );

    const details = screen.getByTestId("job-error-summary");
    expect(details.textContent).toContain("jobs.overview.failureUnavailable");
    expect(details.textContent).not.toContain("Authorization denied");
  });

  test("does not present a successful status message as a failure", () => {
    render(
      <JobOverviewTab
        loading={false}
        job={{
          id: "job-3",
          name: "completed-run",
          status: "completed",
          submittedAt: "2026-08-14T00:00:00.000Z",
          errorMessage: "finished",
          exitCode: 0,
        }}
      />,
    );

    expect(screen.queryByTestId("job-error-summary")).toBeNull();
  });

  test("shows the scheduler allocation and pending reason", () => {
    render(
      <JobOverviewTab
        loading={false}
        job={{
          id: "job-4",
          name: "queued-run",
          status: "queued",
          submittedAt: "2026-08-14T00:00:00.000Z",
          node: "compute-04",
          reason: "Resources",
        }}
      />,
    );

    expect(screen.getByTestId("job-overview-tab").textContent).toContain("compute-04");
    expect(screen.getByTestId("job-overview-tab").textContent).toContain("Resources");
  });
});
