import type { SpackMaterialBinding } from "@kuintessence/shared/browser";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  getStoredActiveOrganizationId,
  useActiveOrganizationId,
} from "../../lib/active-organization";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import { useMeCapabilities } from "../../lib/platform-capabilities";
import { canWriteRecipeRepository } from "../../lib/recipe-repository-access";
import { MaterialCatalog } from "./MaterialCatalog";
import { MaterialPackImport } from "./MaterialPackImport";
import { MaterialReleaseLookup } from "./MaterialReleaseLookup";

function getSessionKey(): string | null {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !auth.email) return null;
  return JSON.stringify([auth.email, auth.revision, auth.role, auth.expiresAt]);
}

export function SpackMaterialsPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const sessionKey = useSyncExternalStore(subscribeAuthState, getSessionKey, () => null);
  const organizationId = useActiveOrganizationId();
  const capabilityState = useMeCapabilities(canManage && sessionKey !== null && !isLocalMode());
  const capabilities = capabilityState.status === "ready" ? capabilityState.data : null;
  const scope = JSON.stringify([sessionKey, organizationId, canManage, capabilities]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const isCurrent = () =>
    getSessionKey() === sessionKey &&
    getStoredActiveOrganizationId() === organizationId &&
    latestScope.current === scope;
  const writable = (repository: string) =>
    isCurrent() &&
    !isLocalMode() &&
    !isMobileHighRiskMutationBlocked("/software/spack/material-repositories") &&
    canWriteRecipeRepository(repository, { canManage, organizationId, capabilities });
  const canImport =
    writable("public/materials") ||
    (!!organizationId && writable(`org/${organizationId}/materials`));
  return (
    <section
      className="min-w-0 space-y-3 py-4"
      aria-label={t("materials.title")}
      data-testid="spack-materials-panel"
    >
      <h2 className="text-sm font-semibold">{t("materials.title")}</h2>
      {sessionKey === null ? (
        <p className="text-xs text-muted-foreground">{t("materials.signedOut")}</p>
      ) : isLocalMode() ? (
        <p className="text-xs text-muted-foreground">{t("materials.unavailable")}</p>
      ) : (
        <MaterialSession
          key={scope}
          canImport={canImport}
          writable={writable}
          isCurrent={isCurrent}
        />
      )}
    </section>
  );
}

function MaterialSession({
  canImport,
  writable,
  isCurrent,
}: {
  canImport: boolean;
  writable: (repository: string) => boolean;
  isCurrent: () => boolean;
}) {
  const [selection, setSelection] = useState<{
    binding: SpackMaterialBinding;
    revision: number;
  }>();
  const inspect = (binding: SpackMaterialBinding) => {
    if (isCurrent()) {
      setSelection((current) => ({ binding, revision: (current?.revision ?? 0) + 1 }));
    }
  };
  return (
    <>
      <MaterialCatalog isCurrent={isCurrent} onInspect={inspect} />
      {canImport ? (
        <MaterialPackImport
          canWriteRepository={writable}
          isCurrent={isCurrent}
          onInspect={inspect}
        />
      ) : null}
      <MaterialReleaseLookup
        key={selection?.revision ?? "lookup"}
        initialBinding={selection?.binding}
        isCurrent={isCurrent}
      />
    </>
  );
}
