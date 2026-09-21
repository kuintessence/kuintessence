import type { MeCapabilities, RecipeRepository } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { isLocalMode } from "../../lib/local-mode";
import { useMeCapabilities } from "../../lib/platform-capabilities";
import { listRecipeRepositories } from "../../lib/recipe-repositories-client";
import { canWriteRecipeRepository } from "../../lib/recipe-repository-access";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RecipeBundleImport } from "./RecipeBundleImport";
import { RecipeRepositoryDetail } from "./RecipeRepositoryDetail";

const KEY = ["spack-recipe-repositories"] as const;

function getRecipeSessionKey(): string | null {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !auth.email) return null;
  return JSON.stringify([auth.email, auth.revision, auth.role, auth.expiresAt]);
}

export function RecipeRepositoriesPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const sessionKey = useSyncExternalStore(subscribeAuthState, getRecipeSessionKey, () => null);
  const organizationId = useActiveOrganizationId();
  const capabilityState = useMeCapabilities(canManage && sessionKey !== null && !isLocalMode());
  const capabilities = capabilityState.status === "ready" ? capabilityState.data : null;
  const accessKey = JSON.stringify([canManage, capabilities]);
  useEffect(() => {
    if (sessionKey === null) client.removeQueries({ queryKey: KEY });
    return () => {
      if (sessionKey !== null) {
        client.removeQueries({ queryKey: [...KEY, sessionKey, accessKey] });
      }
    };
  }, [client, sessionKey, accessKey]);
  if (sessionKey === null) {
    return (
      <section className="space-y-2 py-4" data-testid="recipe-repositories-panel">
        <h2 className="text-sm font-semibold">{t("recipes.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("recipes.signedOut")}</p>
      </section>
    );
  }
  return (
    <RepositoryPanel
      key={JSON.stringify([sessionKey, accessKey, organizationId])}
      sessionKey={sessionKey}
      accessKey={accessKey}
      organizationId={organizationId}
      canManage={canManage}
      capabilities={capabilities}
    />
  );
}

function RepositoryPanel({
  sessionKey,
  accessKey,
  organizationId,
  canManage,
  capabilities,
}: {
  sessionKey: string;
  accessKey: string;
  organizationId: string | null;
  canManage: boolean;
  capabilities: MeCapabilities | null;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentSession = () => mounted.current && getRecipeSessionKey() === sessionKey;
  const canWriteRepository = (repository: string) =>
    currentSession() &&
    canWriteRecipeRepository(repository, { canManage, organizationId, capabilities });
  const writableOrganizationId =
    organizationId && canWriteRepository(`org/${organizationId}/recipes`) ? organizationId : null;
  const canImport = Boolean(writableOrganizationId) || canWriteRepository("public/recipes");
  const scopeKey = [...KEY, sessionKey, accessKey, organizationId];
  const listKey = [...scopeKey, "list"];
  const repositories = useQuery({
    queryKey: listKey,
    queryFn: listRecipeRepositories,
    retry: false,
  });
  function refresh() {
    if (currentSession()) void client.invalidateQueries({ queryKey: scopeKey });
  }
  async function updateRepository(repository: RecipeRepository) {
    if (!currentSession()) return;
    await Promise.all([
      client.cancelQueries({ queryKey: listKey }),
      client.cancelQueries({ queryKey: [...scopeKey, repository.id] }),
    ]);
    // Auth can change while canceled reads settle; never restore an old session's cache.
    if (!currentSession()) return;
    client.setQueryData<RecipeRepository[]>(listKey, (current) => {
      const rows = current ?? [];
      return rows.some((row) => row.id === repository.id)
        ? rows.map((row) => (row.id === repository.id ? repository : row))
        : [...rows, repository];
    });
    client.setQueryData([...scopeKey, repository.id], repository);
  }
  return (
    <section
      aria-label={t("recipes.title")}
      className="min-w-0 space-y-3 py-4"
      data-testid="recipe-repositories-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("recipes.title")}</h2>
        <Button
          size="icon"
          variant="ghost"
          title={t("recipes.refresh")}
          aria-label={t("recipes.refresh")}
          disabled={repositories.isFetching}
          onClick={refresh}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {["validationMode", "concretizationStatus", "agentDeliveryStatus"].map((key) => (
          <Badge key={key} variant="outline">
            {t(`recipes.${key}`)}
          </Badge>
        ))}
      </div>
      {canImport ? (
        <RecipeBundleImport
          organizationId={writableOrganizationId}
          canWriteRepository={canWriteRepository}
          onImported={updateRepository}
        />
      ) : null}
      {repositories.isPending ? (
        <p role="status" className="text-xs">
          {t("recipes.loading")}
        </p>
      ) : repositories.error ? (
        <p role="alert" className="text-xs text-status-failed">
          {toUserFacingError(repositories.error, t("recipes.loadFailed"))}
        </p>
      ) : repositories.data?.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("recipes.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" aria-label={t("recipes.title")}>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["repository", "activeCommit", "snapshots", "actions"].map((key) => (
                  <th key={key} className="p-2 font-medium">
                    {t(`recipes.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repositories.data?.map((repository) => (
                <tr key={repository.id} className="border-b border-border">
                  <td className="break-all p-2 font-mono">
                    {repository.repository}
                    {!canWriteRepository(repository.repository) ? (
                      <Badge className="ml-2 font-sans" variant="outline">
                        {t("recipes.readOnly")}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="break-all p-2 font-mono">
                    {repository.activeCommit ?? t("recipes.inactive")}
                  </td>
                  <td className="p-2">{repository.snapshots.length}</td>
                  <td className="p-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("recipes.inspect", { repository: repository.repository })}
                      aria-label={t("recipes.inspect", { repository: repository.repository })}
                      aria-pressed={selectedId === repository.id}
                      onClick={() => setSelectedId(repository.id)}
                    >
                      <Eye />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedId && !repositories.error ? (
        <RecipeRepositoryDetail
          key={selectedId}
          id={selectedId}
          queryKey={[...scopeKey, selectedId]}
          canWriteRepository={canWriteRepository}
          onUpdated={updateRepository}
          onRefresh={refresh}
        />
      ) : null}
    </section>
  );
}
