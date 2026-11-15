import { expect, test } from "bun:test";
import { checkSource } from "./check-ui-surfaces";

test("rejects Card nesting and structural chrome through expressions", () => {
  expect(checkSource("<PageShell><Card /></PageShell>").violations).toHaveLength(1);
  expect(
    checkSource(
      '<DialogContent><section className={cn("rounded-md", active && "bg-muted")} /></DialogContent>',
    ).violations,
  ).toHaveLength(1);
  expect(
    checkSource(
      '<Card><div className="border-b border-border gap-4"><Input className="rounded-md border" /></div></Card>',
    ).violations,
  ).toHaveLength(0);
});
