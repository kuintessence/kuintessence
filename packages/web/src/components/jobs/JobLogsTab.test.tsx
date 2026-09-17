import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobLogsTab } from "./JobLogsTab";

const apiClient = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    ApiError,
    api: {
      get: vi.fn(),
    },
  };
});

const terminal = vi.hoisted(() => ({
  reset: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../../lib/api-client", () => apiClient);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ resolved: "light" }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = vi.fn();
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    loadAddon = vi.fn();
    open = vi.fn();
    reset = terminal.reset;
    write = terminal.write;
    dispose = vi.fn();
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("JobLogsTab", () => {
  test("keeps the unavailable state compact when the logs endpoint is missing", async () => {
    apiClient.api.get.mockRejectedValue(
      new apiClient.ApiError(404, "NOT_FOUND", "Logs endpoint missing"),
    );

    render(<JobLogsTab jobId="job-1" />);

    expect(await screen.findByTestId("job-logs-unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("job-logs-terminal")).toBeNull());
  });

  test("explains when the Server confirms that a log file is unavailable", async () => {
    apiClient.api.get.mockRejectedValue(
      new apiClient.ApiError(410, "JOB_LOG_UNAVAILABLE", "Job logs are unavailable"),
    );

    render(<JobLogsTab jobId="job-1" />);

    expect(await screen.findByText("jobs.logs.unavailable")).toBeTruthy();
  });

  test("renders the terminal when log text is available", async () => {
    apiClient.api.get.mockResolvedValue({ text: "hello\n" });

    render(<JobLogsTab jobId="job-1" />);

    expect(await screen.findByTestId("job-logs-terminal")).toBeTruthy();
    await waitFor(() => expect(terminal.write).toHaveBeenCalledWith("hello\n"));
  });
});
