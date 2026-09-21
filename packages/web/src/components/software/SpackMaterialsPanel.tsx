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
import {
  MaterialManagementCatalog,
  type MaterialManagementFilter,
} from "./MaterialManagementCatalog";
import { MaterialManagementEditors } from "./MaterialManagementEditors";
import { MaterialPackImport } from "./MaterialPackImport";
import { MaterialReleaseLookup } from "./MaterialReleaseLookup";
import { SpackOnlineImport } from "./SpackOnlineImport";

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
  const manageable = (repository: string) =>
    isCurrent() &&
    !isLocalMode() &&
    canWriteRecipeRepository(repository, { canManage, organizationId, capabilities });
  const writable = (repository: string) =>
    manageable(repository) &&
    !isMobileHighRiskMutationBlocked("/software/spack/material-repositories");
  const canImport =
    writable("public/materials") ||
    (!!organizationId && writable(`org/${organizationId}/materials`));
  const canInspectLifecycle =
    manageable("public/materials") ||
    (!!organizationId && manageable(`org/${organizationId}/materials`));
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
          canInspectLifecycle={canInspectLifecycle}
          writable={writable}
          manageable={manageable}
          isCurrent={isCurrent}
        />
      )}
    </section>
  );
}

function MaterialSession({
  canImport,
  canInspectLifecycle,
  writable,
  manageable,
  isCurrent,
}: {
  canImport: boolean;
  canInspectLifecycle: boolean;
  writable: (repository: string) => boolean;
  manageable: (repository: string) => boolean;
  isCurrent: () => boolean;
}) {
  const [selection, setSelection] = useState<{
    binding: SpackMaterialBinding;
    revision: number;
    mode: "inspect" | "manage";
  }>();
  const [managementFilter, setManagementFilter] = useState<MaterialManagementFilter>({
    repository: "",
    state: "all",
    limit: 10,
  });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [detailsStale, setDetailsStale] = useState(false);
  const [selectionLocked, setSelectionLocked] = useState(false);
  const selectionGuard = useRef(false);
  const inspect = (binding: SpackMaterialBinding) => {
    if (isCurrent() && !selectionGuard.current) {
      setDetailsStale(false);
      setSelection((current) => ({
        binding,
        revision: (current?.revision ?? 0) + 1,
        mode: "inspect",
      }));
    }
  };
  const manage = (binding: SpackMaterialBinding) => {
    if (isCurrent() && canInspectLifecycle && !selectionGuard.current) {
      setDetailsStale(true);
      setSelection((current) => ({
        binding,
        revision: (current?.revision ?? 0) + 1,
        mode: "manage",
      }));
    }
  };
  return (
    <>
      <MaterialCatalog
        key={catalogRevision}
        isCurrent={isCurrent}
        onInspect={inspect}
        inspectionDisabled={selectionLocked}
      />
      {canInspectLifecycle ? (
        <MaterialManagementCatalog
          key={`management:${catalogRevision}`}
          initialFilter={managementFilter}
          onFilterChange={setManagementFilter}
          isCurrent={isCurrent}
          canInspectRepository={manageable}
          onManage={manage}
          inspectionDisabled={selectionLocked}
        />
      ) : null}
      {canImport ? (
        <MaterialPackImport
          canWriteRepository={writable}
          isCurrent={isCurrent}
          onInspect={inspect}
        />
      ) : null}
      {canImport ? (
        <SpackOnlineImport
          kind="material"
          canWriteRepository={writable}
          isCurrent={isCurrent}
          onImported={(result) => {
            if (result.kind === "material") inspect(result.binding);
          }}
        />
      ) : null}
      <MaterialReleaseLookup
        key={`${selection?.revision ?? "lookup"}:${catalogRevision}`}
        initialBinding={
          detailsStale || selection?.mode === "manage" ? undefined : selection?.binding
        }
        isCurrent={isCurrent}
      />
      {canInspectLifecycle ? (
        <MaterialManagementEditors
          key={selection?.revision ?? "lifecycle"}
          initialBinding={selection?.binding}
          isCurrent={isCurrent}
          canWriteRepository={writable}
          canInspectRepository={manageable}
          onSelectionLockChange={(locked) => {
            selectionGuard.current = locked;
            setSelectionLocked(locked);
          }}
          onInvalidate={() => {
            if (!isCurrent()) return;
            setDetailsStale(true);
            setCatalogRevision((revision) => revision + 1);
          }}
        />
      ) : null}
    </>
  );
}
