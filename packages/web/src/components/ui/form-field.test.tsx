import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { FormField } from "./form-field";
import { Input } from "./input";
import { NativeSelect } from "./native-select";

afterEach(cleanup);

test("fields link unique controls to their label, help and current error", () => {
  const view = render(
    <>
      <FormField label="Name" description="Use a unique name" error="Name is required">
        {(field) => <Input {...field} name="name" />}
      </FormField>
      <FormField label="Cluster">{(field) => <NativeSelect {...field} />}</FormField>
    </>,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  const cluster = screen.getByRole("combobox", { name: "Cluster" });
  expect(name.id).not.toBe(cluster.id);
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(
    name
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent),
  ).toEqual(["Use a unique name", "Name is required"]);
  view.rerender(<FormField label="Name">{(field) => <Input {...field} />}</FormField>);
  expect(screen.getByRole("textbox", { name: "Name" }).hasAttribute("aria-invalid")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});
