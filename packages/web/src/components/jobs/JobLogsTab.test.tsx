import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
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
  buffers: [] as Array<{ text: string }>,
  theme: "light",
  translate: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
}));

vi.mock("../../lib/api-client", () => apiClient);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: terminal.translate,
  }),
}));

vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ resolved: terminal.theme }),
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
    buffer = { text: "" };
    constructor() {
      terminal.buffers.push(this.buffer);
    }
    reset() {
      this.buffer.text = "";
      terminal.reset();
    }
    write(text: string) {
      this.buffer.text += text;
      terminal.write(text);
    }
    dispose = vi.fn();
  },
}));

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  terminal.buffers.length = 0;
  terminal.theme = "light";
  vi.clearAllMocks();
});

describe("JobLogsTab", () => {
  test("keeps the unavailable state compact when the logs endpoint is missing", async () => {
    apiClient.api.get.mockRejectedValue(
      new apiClient.ApiError(404, "NOT_FOUND", "Logs endpoint missing"),
    );

    render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });

    expect(await screen.findByTestId("job-logs-unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("job-logs-terminal")).toBeNull());
  });

  test("explains when the Server confirms that a log file is unavailable", async () => {
    apiClient.api.get.mockRejectedValue(
      new apiClient.ApiError(410, "JOB_LOG_UNAVAILABLE", "Job logs are unavailable"),
    );

    render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });

    expect(await screen.findByText("jobs.logs.unavailable")).toBeTruthy();
  });

  test("renders the terminal when log text is available", async () => {
    apiClient.api.get.mockResolvedValue({ text: "hello\n" });

    render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });

    expect(await screen.findByTestId("job-logs-terminal")).toBeTruthy();
    await waitFor(() => expect(terminal.write).toHaveBeenCalledWith("hello\n"));
  });
});

test("replays unchanged logs when the theme recreates the terminal", async () => {
  apiClient.api.get.mockResolvedValue({ text: "first line\n" });
  const { rerender } = render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });
  await waitFor(() => expect(terminal.buffers.at(-1)?.text).toBe("first line\n"));
  terminal.theme = "dark";
  rerender(<JobLogsTab jobId="job-1" />);
  await waitFor(() => expect(terminal.buffers.at(-1)?.text).toBe("first line\n"));
});

test("replays full logs immediately after a failed read is retried", async () => {
  apiClient.api.get
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ text: "recovered\n" });
  render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });
  await screen.findByTestId("job-logs-unavailable");
  fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
  await waitFor(() => expect(terminal.buffers.at(-1)?.text).toBe("recovered\n"));
});

test("does not overlap slow polling requests", async () => {
  let finish: ((value: { text: string }) => void) | undefined;
  apiClient.api.get.mockImplementation(
    () =>
      new Promise<{ text: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(apiClient.api.get).toHaveBeenCalledTimes(1);
  unmount();
  finish?.({ text: "late\n" });
});

test("clears the previous job's terminal while the next job is loading", async () => {
  apiClient.api.get.mockResolvedValueOnce({ text: "private old logs\n" });
  const { rerender } = render(<JobLogsTab jobId="job-1" />, { wrapper: Wrapper });
  await waitFor(() => expect(terminal.buffers.at(-1)?.text).toBe("private old logs\n"));
  apiClient.api.get.mockImplementation(() => new Promise(() => {}));
  rerender(<JobLogsTab jobId="job-2" />);
  await waitFor(() => expect(terminal.buffers.at(-1)?.text).toBe(""));
});
