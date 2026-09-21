import type {
  SpackMaterialVisibilityPolicy,
  SpackMaterialVisibilityView,
} from "@kuintessence/shared/browser";
import { fireEvent, screen, within } from "@testing-library/react";
import { lifecycleFixture } from "./MaterialLifecycle.test-helpers";

export const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const ORG_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const VISIBILITY_REASON = "Restrict source access";
export const allowlist: SpackMaterialVisibilityPolicy = {
  mode: "allowlist",
  userIds: [USER_ID],
  orgIds: [ORG_ID],
};

export function visibilityFixture(repository = "org/org-a/materials") {
  const material = lifecycleFixture(repository);
  const atRevision = (
    revision: number,
    policy: SpackMaterialVisibilityPolicy = revision % 2 ? allowlist : { mode: "inherit" },
    reason = VISIBILITY_REASON,
  ): SpackMaterialVisibilityView => ({
    binding: material.binding,
    repository,
    revision,
    policy,
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      policy: index === 0 ? policy : (revision - index) % 2 ? allowlist : { mode: "inherit" },
      operatorId: USER_ID,
      reason: index === 0 ? reason : `Visibility audit ${revision - index}`,
      epoch: "11111111-1111-4111-8111-111111111111",
      rolloutRevision: 3,
      createdAt: "2026-09-21T00:00:00.000Z",
    })),
    historyTruncated: revision > 100,
  });
  return { ...material, view: atRevision(0), atRevision };
}

export function visibilityUi() {
  return within(screen.getByTestId("material-visibility"));
}

export function inspectVisibility() {
  fireEvent.click(visibilityUi().getByRole("button", { name: "Inspect visibility policy" }));
}

export function confirmVisibility(policy: SpackMaterialVisibilityPolicy = allowlist) {
  const ui = visibilityUi();
  fireEvent.change(ui.getByLabelText("Visibility policy"), { target: { value: policy.mode } });
  if (policy.mode === "allowlist") {
    fireEvent.change(ui.getByLabelText("Allowed user UUIDs"), {
      target: { value: policy.userIds.join("\n") },
    });
    fireEvent.change(ui.getByLabelText("Allowed organization UUIDs"), {
      target: { value: policy.orgIds.join("\n") },
    });
  }
  fireEvent.change(ui.getByLabelText("Visibility audit reason"), {
    target: { value: VISIBILITY_REASON },
  });
  fireEvent.click(ui.getByRole("checkbox"));
}

export function submitVisibility() {
  fireEvent.click(visibilityUi().getByRole("button", { name: "Save visibility policy" }));
}

export function selectManagementTab(name: "Visibility" | "Lifecycle") {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}
