import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { setAuth } from "../../lib/auth";
import { rememberSelection } from "../../lib/recent-selections";
import { ResourcePickerDialog, ResourceSelect } from "./resource-picker";
import { ResourceSelectField } from "./resource-select-field";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const options = [
  { value: "cpu", label: "CPU queue", description: "East cluster", keywords: ["Slurm"] },
  { value: "gpu", label: "GPU queue", description: "West cluster" },
  { value: "offline", label: "Offline queue", disabled: true, disabledReason: "Maintenance" },
];

test("dropdown searches metadata, rejects disabled choices and can omit search", async () => {
  const change = vi.fn();
  const view = render(
    <ResourceSelect label="Queue" options={options} value="cpu" onValueChange={change} />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  fireEvent.change(screen.getByRole("combobox", { name: "ui.search" }), {
    target: { value: "West" },
  });
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  fireEvent.click(screen.getByRole("option", { name: /GPU queue/ }));
  expect(change).toHaveBeenCalledWith("gpu");
  view.rerender(
    <ResourceSelect
      label="Queue"
      searchable={false}
      options={options}
      value="gpu"
      onValueChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  expect(screen.queryByRole("combobox", { name: "ui.search" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Offline queue/ }));
  expect(change).toHaveBeenCalledTimes(1);
});

test("dialog keeps confirmed value on cancel, preserves draft during filtering and supports multi-select", () => {
  const confirm = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open picker
        </button>
        <ResourcePickerDialog
          open={open}
          onOpenChange={setOpen}
          options={options}
          value={["cpu"]}
          onConfirm={confirm}
          title="Queue"
          multiple
        />
      </>
    );
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole("checkbox", { name: "GPU queue" }));
  fireEvent.change(screen.getByRole("textbox", { name: "ui.search" }), {
    target: { value: "Slurm" },
  });
  expect(screen.queryByRole("checkbox", { name: "GPU queue" })).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("GPU queue");
  fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "GPU queue" }).checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "GPU queue" }));
  fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
  expect(confirm).toHaveBeenCalledWith(["cpu", "gpu"]);
});

test("native-compatible migration preserves real change events, ref, required and FormData", async () => {
  const ref = createRef<HTMLSelectElement>();
  const change = vi.fn();
  function Fixture() {
    const [value, setValue] = useState("");
    return (
      <form aria-label="Job">
        <label htmlFor="queue">Queue</label>
        <ResourceSelectField
          ref={ref}
          id="queue"
          name="queue"
          required
          value={value}
          onChange={(event) => {
            change(event.currentTarget.value);
            setValue(event.currentTarget.value);
          }}
        >
          <option value="">Choose queue</option>
          <option value="cpu">CPU queue</option>
          <optgroup label="Disabled" disabled>
            <option value="gpu">GPU queue</option>
          </optgroup>
        </ResourceSelectField>
      </form>
    );
  }
  render(<Fixture />);
  expect(ref.current?.checkValidity()).toBe(false);
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  fireEvent.click(screen.getByRole("option", { name: /CPU queue/ }));
  await waitFor(() => expect(change).toHaveBeenCalledWith("cpu"));
  expect(ref.current?.value).toBe("cpu");
  expect(ref.current?.checkValidity()).toBe(true);
  expect(
    new FormData(screen.getByRole("form", { name: "Job" }) as HTMLFormElement).get("queue"),
  ).toBe("cpu");
});

test("expanded dialog preserves query and only confirms current available options", async () => {
  const change = vi.fn();
  render(
    <ResourceSelect
      label="Queue"
      expandable
      options={options}
      value="cpu"
      onValueChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  fireEvent.change(screen.getByRole("combobox", { name: "ui.search" }), {
    target: { value: "GPU" },
  });
  fireEvent.click(screen.getByRole("button", { name: "ui.expand" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "ui.search" }).value).toBe(
    "GPU",
  );
  fireEvent.click(within(dialog).getByRole("radio", { name: "GPU queue" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "common.confirm" }));
  expect(change).toHaveBeenCalledWith("gpu");
});

test("uncontrolled native fields restore their visible value after form reset", async () => {
  render(
    <form aria-label="Defaults">
      <ResourceSelectField aria-label="Queue" name="queue" defaultValue="cpu">
        <option value="cpu">CPU queue</option>
        <option value="gpu">GPU queue</option>
      </ResourceSelectField>
      <button type="reset">Reset</button>
    </form>,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  fireEvent.click(screen.getByRole("option", { name: "GPU queue" }));
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("queue")).toBe("gpu");
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Queue" }).textContent).toContain("CPU queue"),
  );
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("queue")).toBe("cpu");
});

test("dialog revalidates a draft when upstream candidates become disabled", () => {
  const confirm = vi.fn();
  const view = render(
    <ResourcePickerDialog
      title="Queue"
      open
      onOpenChange={() => {}}
      options={options}
      value={["cpu"]}
      onConfirm={confirm}
    />,
  );
  view.rerender(
    <ResourcePickerDialog
      title="Queue"
      open
      onOpenChange={() => {}}
      options={options.map((option) => ({ ...option, disabled: true }))}
      value={["cpu"]}
      onConfirm={confirm}
    />,
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "common.confirm" }).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
  expect(confirm).not.toHaveBeenCalled();
});

test("recent groups isolate live user and organization scopes and discard unavailable IDs", async () => {
  setAuth({ email: "alice@example.test" });
  localStorage.setItem("kq_active_organization_id", "east");
  const scope = { userId: "alice@example.test", organizationId: "east", resourceType: "queues" };
  for (const id of ["gpu", "offline", "deleted"]) rememberSelection(scope, id);
  render(
    <ResourceSelect
      label="Queue"
      recent
      resourceType="queues"
      options={options}
      value="cpu"
      onValueChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
  const recent = screen.getByText("ui.recent").parentElement;
  expect(recent?.textContent).toContain("GPU queue");
  expect(recent?.textContent).not.toContain("Offline queue");
  expect(recent?.textContent).not.toContain("deleted");
  act(() => {
    localStorage.setItem("kq_active_organization_id", "west");
    window.dispatchEvent(new Event("kq:active-organization-change"));
  });
  expect(screen.queryByText("ui.recent")).toBeNull();
  act(() => setAuth({ email: "bob@example.test" }));
  expect(screen.queryByText("ui.recent")).toBeNull();
});

test("server dialog delegates queries, sorting and pagination without filtering the current page", () => {
  const search = vi.fn();
  const sort = vi.fn();
  const paginate = vi.fn();
  const props = {
    title: "Queue",
    open: true,
    onOpenChange: vi.fn(),
    options,
    value: ["cpu"],
    onConfirm: vi.fn(),
    queryMode: "server" as const,
    search: "not-on-this-page",
    onSearchChange: search,
    filterOption: () => false,
    tableQuery: {
      rowCount: 45,
      pagination: { pageIndex: 1, pageSize: 10 },
      sorting: [],
      onSortingChange: sort,
      onPaginationChange: paginate,
    },
  };
  const view = render(<ResourcePickerDialog {...props} />);
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "West" } });
  expect(search).toHaveBeenCalledWith("West");
  view.rerender(<ResourcePickerDialog {...props} search="externally-updated" />);
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("externally-updated");
  fireEvent.click(screen.getByRole("button", { name: "ui.name" }));
  expect(sort).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "common.pagination.next" }));
  expect(paginate).toHaveBeenCalledTimes(1);
});

test.each(["dialog", "sheet"])("nested search retains focus in a parent %s", async (kind) => {
  const { Dialog, DialogContent, DialogTitle } = await import("./dialog");
  const { Sheet, SheetContent, SheetTitle } = await import("./sheet");
  const picker = (
    <ResourceSelect label="Nested queue" options={options} value="" onValueChange={() => {}} />
  );
  render(
    kind === "dialog" ? (
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Parent</DialogTitle>
          {picker}
        </DialogContent>
      </Dialog>
    ) : (
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle>Parent</SheetTitle>
          {picker}
        </SheetContent>
      </Sheet>
    ),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Nested queue" }));
  const search = await screen.findByRole("combobox", { name: "ui.search" });
  search.focus();
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "West" } });
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
});
