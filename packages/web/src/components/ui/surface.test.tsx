import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Card } from "./card";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { PageShell } from "./page";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

test("cards composed through other components never create a second decorated surface", () => {
  function Metrics() {
    return (
      <Card>
        <Card>Metrics</Card>
      </Card>
    );
  }
  const view = render(
    <PageShell>
      <Metrics />
    </PageShell>,
  );
  expect(view.container.querySelectorAll('[data-kq-surface="region"]')).toHaveLength(1);
  expect(view.container.querySelectorAll('[data-kq-surface="section"]')).toHaveLength(2);
  expect(
    view.container.querySelector('[data-kq-surface="region"] [data-kq-surface="region"]'),
  ).toBeNull();
});

test("a dialog is a new outer surface while its composed content stays flat", () => {
  render(
    <PageShell>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Selection</DialogTitle>
          <Card>Details</Card>
        </DialogContent>
      </Dialog>
    </PageShell>,
  );
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("data-kq-surface")).toBe("region");
  expect(dialog?.querySelector('[data-kq-surface="region"]')).toBeNull();
});
