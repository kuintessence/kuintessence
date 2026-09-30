import type { SpackInstallBindingView } from "@kuintessence/shared/browser";
import { fireEvent, screen, within } from "@testing-library/react";

export const BINDING_ORG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const INSTALL_SPEC = "hello@2.12.1";
export const INSTALL_REASON = "Use reviewed release";
export const installBinding = {
  repositoryId: "a".repeat(64),
  manifestDigest: `sha256:${"b".repeat(64)}`,
};

export function installBindingView(revision = 0, scope = BINDING_ORG): SpackInstallBindingView {
  return {
    scope,
    spec: INSTALL_SPEC,
    revision,
    state: revision ? "enabled" : "absent",
    binding: revision ? installBinding : null,
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      state: "enabled",
      binding: installBinding,
      source: "web",
      operatorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      reason: INSTALL_REASON,
      createdAt: "2026-09-30T00:00:00.000Z",
    })),
    historyTruncated: revision > 100,
  };
}

export function bindingUi() {
  return within(screen.getByTestId("spack-install-binding-editor"));
}

export function inspectBinding() {
  fireEvent.click(bindingUi().getByRole("button", { name: "Inspect installation binding" }));
}

export async function readyBinding() {
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: INSTALL_SPEC },
  });
  inspectBinding();
  await screen.findByTestId("spack-install-binding-detail");
}

export function confirmBinding() {
  fireEvent.change(bindingUi().getByLabelText("Installation binding audit reason"), {
    target: { value: INSTALL_REASON },
  });
  fireEvent.click(bindingUi().getByRole("checkbox"));
}

export function submitBinding() {
  fireEvent.click(bindingUi().getByRole("button", { name: "Save installation binding" }));
}
