import { ApiError } from "@kuintessence/shared/browser";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SpackInstallBindingEditor } from "../../src/components/software/SpackInstallBindingEditor";
import { setLang } from "../../src/lib/i18n";
import {
  isMobileHighRiskMutationBlocked,
  setMobileManagementPolicy,
} from "../../src/lib/mobile-management-policy";
import { changeSpackInstallBinding } from "../../src/lib/spack-install-bindings-client";

const mutationPath = "/software/spack/install-bindings";
const selection = {
  repositoryId: "b".repeat(64),
  manifestDigest: `sha256:${"c".repeat(64)}`,
};
const isCurrent = () => true;

function BindingFixture() {
  const organizationId = sessionStorage.getItem("kq.install-binding-fixture.org");
  const scope = organizationId ?? "platform";
  const [probe, setProbe] = useState("idle");
  const canInspectScope = (value: string) => value === scope;
  const canWriteScope = (value: string) =>
    canInspectScope(value) && !isMobileHighRiskMutationBlocked(mutationPath);
  return (
    <main
      className="mx-auto min-w-0 max-w-6xl p-4"
      data-testid="install-binding-fixture"
      data-mobile-writes-blocked={isMobileHighRiskMutationBlocked(mutationPath)}
    >
      <SpackInstallBindingEditor
        organizationId={organizationId}
        selection={selection}
        isCurrent={isCurrent}
        canInspectScope={canInspectScope}
        canWriteScope={canWriteScope}
      />
      <button
        type="button"
        className="text-xs"
        data-testid="probe-client-write"
        onClick={async () => {
          try {
            await changeSpackInstallBinding({
              scope,
              spec: "hello@1.0",
              action: "disable",
              expectedRevision: 1,
              reason: "Browser fixture mobile guard probe",
            });
            setProbe("unexpected-success");
          } catch (error) {
            setProbe(error instanceof ApiError ? error.code : "unexpected-error");
          }
        }}
      >
        Probe client write guard
      </button>
      <output className="block break-all text-xs" data-testid="client-write-result">
        {probe}
      </output>
    </main>
  );
}

setLang("en");
setMobileManagementPolicy(true);
const root = document.getElementById("root");
if (!root) throw new Error("Missing install binding fixture root");
createRoot(root).render(<BindingFixture />);
