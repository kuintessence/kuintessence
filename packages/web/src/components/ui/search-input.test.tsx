import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { SearchInput } from "./search-input";

afterEach(cleanup);

test("search fields retain label, ref, form value and native change events", () => {
  const ref = createRef<HTMLInputElement>();
  const onChange = vi.fn();
  const view = render(
    <form>
      <label htmlFor="search">Search jobs</label>
      <SearchInput id="search" name="query" ref={ref} onChange={onChange} />
    </form>,
  );
  const input = screen.getByRole("textbox", { name: "Search jobs" }) as HTMLInputElement;
  expect(ref.current).toBe(input);
  fireEvent.change(input, { target: { value: "simulation" } });
  expect(onChange).toHaveBeenCalledOnce();
  const form = view.container.querySelector("form");
  expect(form && new FormData(form).get("query")).toBe("simulation");
  ref.current?.focus();
  expect(document.activeElement).toBe(input);
  view.rerender(<SearchInput aria-label="Search jobs" disabled />);
  expect((screen.getByRole("textbox", { name: "Search jobs" }) as HTMLInputElement).disabled).toBe(
    true,
  );
});
