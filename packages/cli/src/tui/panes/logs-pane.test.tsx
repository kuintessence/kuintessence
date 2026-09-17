import { describe, expect, test } from "bun:test";
import type { TuiJob } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { LogsPane } from "./logs-pane";

const job: TuiJob = { id: "a1", name: "wrf", status: "running", location: "compute" };

function logsState(over: Partial<TuiState["logs"]>): TuiState {
  return {
    ...initialState(),
    view: "logs",
    logs: { loading: false, text: "", following: false, scroll: 0, search: "", ...over },
  };
}

describe("LogsPane", () => {
  test("renders the job title and log lines", async () => {
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text: "starting\nstep 1 done\n" })} job={job} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Logs — wrf (a1)");
    expect(frame).toContain("starting");
    expect(frame).toContain("step 1 done");
  });

  test("shows a loading line on first fetch", async () => {
    const { lastFrame } = await render(<LogsPane state={logsState({ loading: true })} job={job} />);
    expect(lastFrame() ?? "").toContain("Loading logs…");
  });

  test("shows an empty-output notice", async () => {
    const { lastFrame } = await render(<LogsPane state={logsState({ text: "" })} job={job} />);
    expect(lastFrame() ?? "").toContain("(no output yet)");
  });

  test("shows a LIVE indicator while following", async () => {
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text: "x\n", following: true })} job={job} />,
    );
    expect(lastFrame() ?? "").toContain("●LIVE");
  });

  test("surfaces a logs error", async () => {
    const { lastFrame } = await render(
      <LogsPane state={logsState({ error: "logs unavailable" })} job={job} />,
    );
    expect(lastFrame() ?? "").toContain("logs unavailable");
  });

  test("truncates to the last 20 lines with an elision notice", async () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const { lastFrame } = await render(<LogsPane state={logsState({ text })} job={job} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("… 10 earlier lines");
    expect(frame).toContain("line 30");
    expect(frame).not.toContain("line 5\n");
  });

  test("a smaller viewport shows fewer lines (adaptive height)", async () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text })} job={job} viewportRows={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 30");
    expect(frame).toContain("line 21");
    expect(frame).not.toContain("line 20\n");
    expect(frame).toContain("… 20 earlier lines");
  });

  test("scrollback reveals earlier lines and notes the newer ones below", async () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text, scroll: 5 })} job={job} viewportRows={10} />,
    );
    const frame = lastFrame() ?? "";
    // window ends 5 lines up from the bottom: lines 16..25 visible
    expect(frame).toContain("line 25");
    expect(frame).toContain("line 16");
    expect(frame).not.toContain("line 30");
    expect(frame).toContain("↓ 5 newer lines");
    expect(frame).toContain("… 15 earlier lines");
  });

  test("a search term greps the buffer to matching lines", async () => {
    const text = "alpha error\nbeta ok\ngamma ERROR\ndelta fine\n";
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text, search: "error" })} job={job} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("alpha error");
    expect(frame).toContain("gamma ERROR");
    expect(frame).not.toContain("beta ok");
    expect(frame).not.toContain("delta fine");
    expect(frame).toContain("error");
  });

  test("a search with no matches shows a notice", async () => {
    const text = "alpha\nbeta\n";
    const { lastFrame } = await render(
      <LogsPane state={logsState({ text, search: "zzz" })} job={job} />,
    );
    expect(lastFrame() ?? "").toContain('no lines match "zzz"');
  });
});
