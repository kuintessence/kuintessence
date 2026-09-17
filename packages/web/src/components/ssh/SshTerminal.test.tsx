import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const terminalMock = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { theme?: unknown };
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

// xterm hits the DOM directly. Mocking it keeps the component tests focused on
// the surrounding state/lifecycle logic, mirroring the approach used by other
// xterm-bearing components in the suite.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: { theme?: unknown };
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    onResize = vi.fn().mockReturnValue({ dispose: vi.fn() });
    dispose = vi.fn();
    constructor(options: { theme?: unknown }) {
      this.options = options;
      terminalMock.instances.push(this);
    }
  }
  return { Terminal };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon };
});

const useSshStreamMock = vi.fn();
vi.mock("../../lib/use-ssh-stream", () => ({
  useSshStream: (...args: unknown[]) => useSshStreamMock(...args),
}));

vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ resolved: "light" }),
}));

import { resetSshTerminalViewsForTests, SshTerminal } from "./SshTerminal";

interface MockHookReturn {
  state: "idle" | "connecting" | "connected" | "closed";
  lastReason: string | null;
  lastCode: number | null;
  send: (b: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: ((b: Uint8Array) => void) | null) => void;
  readTranscript: () => Uint8Array[];
  reconnect: () => void;
}

function setHook(partial: Partial<MockHookReturn>) {
  const value: MockHookReturn = {
    state: "connecting",
    lastReason: null,
    lastCode: null,
    send: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    readTranscript: vi.fn(() => []),
    reconnect: vi.fn(),
    ...partial,
  };
  useSshStreamMock.mockReturnValue(value);
  return value;
}

beforeEach(() => {
  useSshStreamMock.mockReset();
  terminalMock.instances.length = 0;
});

afterEach(() => {
  resetSshTerminalViewsForTests();
  vi.clearAllMocks();
});

describe("SshTerminal", () => {
  test("renders the connecting banner while the WS is opening", () => {
    setHook({ state: "connecting" });
    render(<SshTerminal agentId="agent-1" />);
    expect(screen.getByTestId("ssh-status").textContent).toContain("ssh.terminal.connecting");
  });

  test("renders the connected status once the socket opens", () => {
    setHook({ state: "connected" });
    render(<SshTerminal agentId="agent-1" />);
    expect(screen.getByTestId("ssh-status").textContent).toContain("ssh.terminal.connected");
  });

  test("renders the disconnected reason when the socket is closed", () => {
    setHook({ state: "closed", lastReason: "agent offline", lastCode: 4404 });
    render(<SshTerminal agentId="agent-1" />);
    const banner = screen.getByTestId("ssh-status");
    expect(banner.textContent).toContain("ssh.terminal.disconnected");
    expect(banner.textContent).toContain("ssh.terminal.offline");
    expect(banner.textContent).not.toContain("agent offline");
  });

  test("renders the unauthorized panel when the hook reports `unauthorized`", () => {
    setHook({ state: "closed", lastReason: "unauthorized", lastCode: 401 });
    render(<SshTerminal agentId="agent-1" />);
    expect(screen.getByTestId("ssh-unauthorized")).toBeDefined();
    expect(screen.getByTestId("ssh-unauthorized").textContent).toContain(
      "ssh.terminal.unauthorized",
    );
  });

  test("renders the agent-offline panel on close code 4404", () => {
    setHook({ state: "closed", lastReason: "agent foo not online", lastCode: 4404 });
    render(<SshTerminal agentId="agent-1" />);
    expect(screen.getByTestId("ssh-offline")).toBeDefined();
    expect(screen.getByTestId("ssh-offline").textContent).toContain("ssh.terminal.offline");
  });

  test("clicking Reconnect calls hook.reconnect()", () => {
    const reconnect = vi.fn();
    setHook({ state: "closed", lastReason: "boom", lastCode: 1006, reconnect });
    render(<SshTerminal agentId="agent-1" />);

    const btn = screen.getByTestId("ssh-reconnect") as HTMLButtonElement;
    btn.click();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  test("does not render an unknown WebSocket close reason", () => {
    setHook({ state: "closed", lastReason: "Authorization denied", lastCode: 1000 });
    render(<SshTerminal agentId="agent-unknown-close" />);
    expect(screen.getByTestId("ssh-status").textContent).not.toContain("Authorization denied");
  });

  test("registers an inbound-data callback via hook.onData", () => {
    const onData = vi.fn();
    setHook({ state: "connecting", onData });
    render(<SshTerminal agentId="agent-1" />);
    expect(onData).toHaveBeenCalled();
    // The component should hand the hook a function (not null) so it can pipe
    // bytes into the xterm instance.
    const cb = onData.mock.calls.at(-1)?.[0];
    expect(typeof cb).toBe("function");
  });

  test("restores buffered output from the shared session transcript", () => {
    setHook({
      state: "connected",
      readTranscript: vi.fn(() => [new TextEncoder().encode("hello from ssh\r\n")]),
    });

    render(<SshTerminal agentId="agent-cache-test" />);
    const terminal = terminalMock.instances.at(-1);
    expect(terminal?.write).toHaveBeenCalledWith(new TextEncoder().encode("hello from ssh\r\n"));
  });

  test("keeps the xterm instance alive when remounting the same agent", () => {
    setHook({ state: "connected" });

    const first = render(<SshTerminal agentId="agent-persistent-xterm" />);
    const firstTerminal = terminalMock.instances.at(-1);
    first.unmount();

    render(<SshTerminal agentId="agent-persistent-xterm" />);

    expect(terminalMock.instances).toHaveLength(1);
    expect(firstTerminal?.dispose).not.toHaveBeenCalled();
    expect(firstTerminal?.open).toHaveBeenCalledTimes(1);
  });

  test("preserves the old xterm instance across agent A to B to A switching", () => {
    const callbacks = new Map<string, ((b: Uint8Array) => void) | null>();
    useSshStreamMock.mockImplementation((agentId: string) => ({
      state: "connected",
      lastReason: null,
      lastCode: null,
      send: vi.fn(),
      resize: vi.fn(),
      onData: (cb: ((b: Uint8Array) => void) | null) => callbacks.set(agentId, cb),
      readTranscript: vi.fn(() => []),
      reconnect: vi.fn(),
    }));

    const agentA = render(<SshTerminal agentId="agent-a" />);
    const terminalA = terminalMock.instances[0];
    callbacks.get("agent-a")?.(new TextEncoder().encode("operation output\r\n"));
    agentA.unmount();

    const agentB = render(<SshTerminal agentId="agent-b" />);
    const terminalB = terminalMock.instances[1];
    agentB.unmount();

    render(<SshTerminal agentId="agent-a" />);

    expect(terminalMock.instances).toHaveLength(2);
    expect(terminalA).not.toBe(terminalB);
    expect(terminalA?.write).toHaveBeenCalledWith(new TextEncoder().encode("operation output\r\n"));
    expect(terminalA?.dispose).not.toHaveBeenCalled();
    expect(terminalA?.open).toHaveBeenCalledTimes(1);
  });
});
