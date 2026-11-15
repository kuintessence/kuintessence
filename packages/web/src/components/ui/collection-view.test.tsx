import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { CollectionView } from "./collection-view";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const data = [
  { id: "gpu", name: "GPU queue" },
  { id: "cpu", name: "CPU queue" },
];
const columns: ColumnDef<(typeof data)[number]>[] = [{ accessorKey: "name", header: "Name" }];

test("controlled local queries filter the complete collection", () => {
  function Fixture() {
    const [search, setSearch] = useState("");
    return (
      <CollectionView
        data={data}
        columns={columns}
        getKey={(row) => row.id}
        search={search}
        onSearchChange={setSearch}
      />
    );
  }
  render(<Fixture />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "CPU" } });
  expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["CPU queue"]);
});

test("server collection preserves the supplied page and delegates query changes", () => {
  const change = vi.fn();
  const sort = vi.fn();
  const paginate = vi.fn();
  render(
    <CollectionView
      queryMode="server"
      data={data}
      columns={columns}
      getKey={(row) => row.id}
      search="not-on-this-page"
      onSearchChange={change}
      matches={() => false}
      table={{
        rowCount: 45,
        pagination: { pageIndex: 1, pageSize: 10 },
        sorting: [],
        onSortingChange: sort,
        onPaginationChange: paginate,
      }}
    />,
  );
  expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "GPU queue",
    "CPU queue",
  ]);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "West" } });
  expect(change).toHaveBeenCalledWith("West");
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(sort).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "common.pagination.next" }));
  expect(paginate).toHaveBeenCalledTimes(1);
});
