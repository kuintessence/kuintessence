import type { SpackMaterialBinding } from "@kuintessence/shared/browser";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MaterialLifecycle } from "../../src/components/software/MaterialLifecycle";
import { setLang } from "../../src/lib/i18n";
import {
  isMobileHighRiskMutationBlocked,
  setMobileManagementPolicy,
} from "../../src/lib/mobile-management-policy";

const repository = "public/materials";
const mutationPath = "/software/spack/material-repositories";
const isCurrent = () => true;
const canInspectRepository = (name: string) => name === repository;
const canWriteRepository = (name: string) =>
  canInspectRepository(name) && !isMobileHighRiskMutationBlocked(mutationPath);

function LifecycleFixture({ binding }: { binding: SpackMaterialBinding }) {
  const [invalidations, setInvalidations] = useState(0);
  return (
    <main
      className="mx-auto min-w-0 max-w-6xl p-4"
      data-testid="lifecycle-fixture"
      data-mobile-writes-blocked={isMobileHighRiskMutationBlocked(mutationPath)}
    >
      <MaterialLifecycle
        initialBinding={binding}
        isCurrent={isCurrent}
        canWriteRepository={canWriteRepository}
        canInspectRepository={canInspectRepository}
        onInvalidate={() => setInvalidations((count) => count + 1)}
      />
      <output data-testid="invalidation-count" aria-label="Invalidation count">
        {invalidations}
      </output>
    </main>
  );
}

async function mount() {
  setLang("en");
  setMobileManagementPolicy(true);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repository));
  const repositoryId = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing lifecycle fixture root");
  createRoot(root).render(
    <LifecycleFixture binding={{ repositoryId, manifestDigest: `sha256:${"b".repeat(64)}` }} />,
  );
}

void mount();
