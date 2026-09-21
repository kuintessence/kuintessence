import type { SpackMaterialBinding } from "@kuintessence/shared/browser";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MaterialLifecycle } from "../../src/components/software/MaterialLifecycle";
import {
  MaterialManagementCatalog,
  type MaterialManagementFilter,
} from "../../src/components/software/MaterialManagementCatalog";
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
  const [selection, setSelection] = useState({ binding, revision: 0 });
  const [locked, setLocked] = useState(false);
  const selectionGuard = useRef(false);
  const [filter, setFilter] = useState<MaterialManagementFilter>({
    repository: "",
    state: "all",
    limit: 10,
  });
  return (
    <main
      className="mx-auto min-w-0 max-w-6xl p-4"
      data-testid="lifecycle-fixture"
      data-mobile-writes-blocked={isMobileHighRiskMutationBlocked(mutationPath)}
    >
      <MaterialManagementCatalog
        key={`management:${invalidations}`}
        initialFilter={filter}
        onFilterChange={setFilter}
        isCurrent={isCurrent}
        canInspectRepository={canInspectRepository}
        inspectionDisabled={locked}
        onManage={(selected) => {
          if (selectionGuard.current) return;
          setSelection((current) => ({ binding: selected, revision: current.revision + 1 }));
        }}
      />
      <MaterialLifecycle
        key={selection.revision}
        initialBinding={selection.binding}
        isCurrent={isCurrent}
        canWriteRepository={canWriteRepository}
        canInspectRepository={canInspectRepository}
        onInvalidate={() => setInvalidations((count) => count + 1)}
        onSelectionLockChange={(value) => {
          selectionGuard.current = value;
          setLocked(value);
        }}
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
