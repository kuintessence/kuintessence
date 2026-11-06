import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { NativeSelect } from "./native-select";

afterEach(cleanup);

test("preserves native ref, event, required validation and form submission", () => {
  const ref = createRef<HTMLSelectElement>();
  const change = vi.fn();
  const { container } = render(
    <form>
      <label>
        Account
        <NativeSelect name="account" required defaultValue="" ref={ref} onChange={change}>
          <option value="" disabled>
            Choose an account
          </option>
          <optgroup label="Cluster">
            <option value="research">Research</option>
          </optgroup>
        </NativeSelect>
      </label>
      <NativeSelect name="disabled" aria-label="Disabled" disabled defaultValue="hidden">
        <option value="hidden">Hidden</option>
      </NativeSelect>
    </form>,
  );
  const control = screen.getByRole("combobox", { name: "Account" });
  expect(ref.current).toBe(control);
  expect(ref.current?.checkValidity()).toBe(false);
  fireEvent.change(control, { target: { value: "research" } });
  expect(change).toHaveBeenCalledOnce();
  expect(ref.current?.checkValidity()).toBe(true);
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
  const submitted = new FormData(form);
  expect(submitted.get("account")).toBe("research");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Disabled" }).disabled).toBe(true);
});
