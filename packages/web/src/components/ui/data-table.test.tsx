import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DataTable } from "./data-table";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

const data = Array.from({ length: 32 }, (_, id) => ({
  id,
  name: `Job ${String(id).padStart(2, "0")}`,
}));
const columns: ColumnDef<(typeof data)[number]>[] = [{ accessorKey: "name", header: "Name" }];

test("sort and pagination controls do not submit their enclosing form", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <DataTable columns={columns} data={data} pageSize={10} />
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("ascending");
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("descending");
  expect(screen.getAllByRole("cell")[0]?.textContent).toBe("Job 31");
  fireEvent.click(screen.getByRole("button", { name: "common.pagination.next" }));
  await waitFor(() => expect(screen.getAllByRole("cell")[0]?.textContent).toBe("Job 21"));
  expect(submit).not.toHaveBeenCalled();
});

test("page size stays adjustable on one page and filtering resets an out-of-range page", async () => {
  const view = render(<DataTable columns={columns} data={data} pageSize={10} />);
  await waitFor(() => expect(screen.getAllByRole("cell")[0]?.textContent).toBe("Job 00"));
  const size = screen.getByRole("combobox", { name: "common.pagination.rowsPerPage" });
  fireEvent.change(size, { target: { value: "50" } });
  expect(screen.getAllByRole("cell")).toHaveLength(32);
  fireEvent.change(size, { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "common.pagination.next" }));
  await waitFor(() => expect(screen.getAllByRole("cell")[0]?.textContent).toBe("Job 10"));
  view.rerender(<DataTable columns={columns} data={data} pageSize={10} globalFilter="Job 00" />);
  await waitFor(() => expect(screen.getByRole("cell").textContent).toBe("Job 00"));
  view.rerender(<DataTable columns={columns} data={data} pageSize={10} globalFilter="missing" />);
  await waitFor(() => expect(screen.getByRole("cell").textContent).toBe("common.empty"));
  expect(screen.queryByRole("combobox")).toBeNull();
});
