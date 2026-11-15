import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Input } from "./input";

afterEach(cleanup);

test("numeric suggestions respect bounds and retain custom values and native validation", () => {
  render(
    <form aria-label="Resources">
      <Input aria-label="CPU" name="cpu" type="number" min={2} max={16} step={2} defaultValue={4} />
    </form>,
  );
  expect(
    [...document.querySelectorAll("datalist option")].map((option) => option.getAttribute("value")),
  ).toEqual(["2", "4", "8", "16"]);
  const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "CPU" });
  fireEvent.change(input, { target: { value: "6" } });
  expect(input.checkValidity()).toBe(true);
  expect(new FormData(screen.getByRole("form") as HTMLFormElement).get("cpu")).toBe("6");
  fireEvent.change(input, { target: { value: "18" } });
  expect(input.checkValidity()).toBe(false);
});
