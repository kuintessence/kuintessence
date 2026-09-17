import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { EditPolicyDialog } from "./EditPolicyDialog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditPolicyDialog", () => {
  test("submitting calls onSubmit with cluster + list + parsed specs", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <EditPolicyDialog
        open
        cluster="cluster-a"
        list="whitelist"
        initialSpecs={["a@1.0", "b@2.0"]}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );

    const textarea = screen.getByTestId("edit-policy-specs") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x@1.0\ny@2.0\n  z@3.0  " } });

    fireEvent.click(screen.getByTestId("edit-policy-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      cluster: "cluster-a",
      list: "whitelist",
      specs: ["x@1.0", "y@2.0", "z@3.0"],
    });
  });

  test("blank specs collapse to an empty array on submit", () => {
    const onSubmit = vi.fn();
    render(
      <EditPolicyDialog
        open
        cluster="c"
        list="blacklist"
        initialSpecs={[]}
        onSubmit={onSubmit}
        onClose={() => undefined}
      />,
    );

    const textarea = screen.getByTestId("edit-policy-specs") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   \n  \n" } });
    fireEvent.click(screen.getByTestId("edit-policy-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ cluster: "c", list: "blacklist", specs: [] });
  });
});
