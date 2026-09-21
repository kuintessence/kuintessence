import type { RecipeRepository } from "@kuintessence/shared/browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Eye, Play, Power, RefreshCw, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  activateRecipeRepository,
  deactivateRecipeRepository,
  getRecipeRepository,
} from "../../lib/recipe-repositories-client";
import { SoftwareError } from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { RecipeSnapshotReport } from "./RecipeSnapshotReport";

type Change =
  | { kind: "activate"; commit: string; expectedActiveCommit: string | null }
  | { kind: "deactivate"; expectedActiveCommit: string };

export function RecipeRepositoryDetail({
  id,
  queryKey,
  canWriteRepository,
  onUpdated,
  onRefresh,
}: {
  id: string;
  queryKey: readonly (string | null)[];
  canWriteRepository: (repository: string) => boolean;
  onUpdated: (repository: RecipeRepository) => Promise<void>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey, queryFn: () => getRecipeRepository(id), retry: false });
  const [inspectedCommit, setInspectedCommit] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [trusted, setTrusted] = useState(false);
  const mutation = useMutation({
    mutationFn: (input: Change) => {
      if (!detail.data || !canWriteRepository(detail.data.repository)) {
        throw new SoftwareError(403, "FORBIDDEN", "Recipe write access is no longer available");
      }
      return input.kind === "activate"
        ? activateRecipeRepository(id, {
            commit: input.commit,
            expectedActiveCommit: input.expectedActiveCommit,
            acknowledgeExecutableRecipes: true,
          })
        : deactivateRecipeRepository(id, input.expectedActiveCommit);
    },
    retry: false,
    onSuccess: async (repository) => {
      await onUpdated(repository);
      setChange(null);
      setTrusted(false);
    },
    onError: () => {
      setChange(null);
      setTrusted(false);
      onRefresh();
    },
  });
  function confirm(input: Change) {
    mutation.reset();
    setTrusted(false);
    setChange(input);
  }
  if (detail.isPending)
    return (
      <p role="status" className="text-xs">
        {t("recipes.loading")}
      </p>
    );
  if (detail.error || !detail.data) {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-status-failed">
        {toUserFacingError(detail.error, t("recipes.detailFailed"))}
        <Button
          size="icon"
          variant="ghost"
          title={t("recipes.refresh")}
          aria-label={t("recipes.refresh")}
          onClick={onRefresh}
        >
          <RefreshCw />
        </Button>
      </div>
    );
  }
  const repository = detail.data;
  const canManage = canWriteRepository(repository.repository);
  const snapshots = [...repository.snapshots].sort((a, b) =>
    b.importedAt.localeCompare(a.importedAt),
  );
  const inspected =
    snapshots.find((snapshot) => snapshot.commit === inspectedCommit) ?? snapshots[0];
  const activeIndex = snapshots.findIndex(
    (snapshot) => snapshot.commit === repository.activeCommit,
  );
  const busy = mutation.isPending || detail.isFetching;
  return (
    <section className="min-w-0 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all text-sm font-medium">{repository.repository}</h3>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            title={t("recipes.refresh")}
            aria-label={t("recipes.refresh")}
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
          {canManage && repository.activeCommit ? (
            <Button
              size="icon"
              variant="ghost"
              title={t("recipes.deactivate")}
              aria-label={t("recipes.deactivate")}
              disabled={busy}
              onClick={() => {
                if (repository.activeCommit)
                  confirm({ kind: "deactivate", expectedActiveCommit: repository.activeCommit });
              }}
            >
              <Power />
            </Button>
          ) : null}
        </div>
      </div>
      {mutation.error ? (
        <p role="alert" className="text-xs text-status-failed">
          {toUserFacingError(mutation.error, t("recipes.writeFailed"))}
        </p>
      ) : null}
      {snapshots.length === 0 ? (
        <p className="text-xs">{t("recipes.noSnapshots")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" aria-label={t("recipes.history")}>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["commit", "importedAt", "importedBy", "actions"].map((key) => (
                  <th className="p-2 font-medium" key={key}>
                    {t(`recipes.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot, index) => {
                const active = snapshot.commit === repository.activeCommit;
                const rollback = activeIndex >= 0 && index > activeIndex;
                const actionLabel = t(rollback ? "recipes.rollback" : "recipes.activate", {
                  commit: snapshot.commit,
                });
                return (
                  <tr key={snapshot.commit} className="border-b border-border">
                    <td className="p-2">
                      <code className="break-all">{snapshot.commit}</code>
                      {active ? (
                        <Badge className="ml-2" variant="outline">
                          {t("recipes.activeCommit")}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap p-2">
                      <time dateTime={snapshot.importedAt}>{snapshot.importedAt}</time>
                    </td>
                    <td className="break-all p-2">{snapshot.importedBy}</td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          title={t("recipes.report", { commit: snapshot.commit })}
                          aria-label={t("recipes.report", { commit: snapshot.commit })}
                          onClick={() => setInspectedCommit(snapshot.commit)}
                        >
                          <Eye />
                        </Button>
                        {canManage && !active ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            title={actionLabel}
                            aria-label={actionLabel}
                            disabled={busy}
                            onClick={() =>
                              confirm({
                                kind: "activate",
                                commit: snapshot.commit,
                                expectedActiveCommit: repository.activeCommit,
                              })
                            }
                          >
                            {rollback ? <Undo2 /> : <Play />}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inspected ? <RecipeSnapshotReport snapshot={inspected} /> : null}
      <Dialog
        open={change !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setChange(null);
            setTrusted(false);
          }
        }}
      >
        <DialogContent dismissible={!mutation.isPending}>
          <DialogHeader>
            <DialogTitle>
              {t(change?.kind === "activate" ? "recipes.activateTitle" : "recipes.deactivateTitle")}
            </DialogTitle>
            <DialogDescription>
              {t(
                change?.kind === "activate"
                  ? "recipes.executableRisk"
                  : "recipes.deactivateWarning",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-xs">
            <p className="break-all">{repository.repository}</p>
            <code className="block break-all">
              {change?.kind === "activate" ? change.commit : change?.expectedActiveCommit}
            </code>
            {change?.kind === "activate" ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={trusted}
                  disabled={mutation.isPending}
                  onChange={(event) => setTrusted(event.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span>{t("recipes.trust")}</span>
              </label>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => {
                setChange(null);
                setTrusted(false);
              }}
            >
              {t("recipes.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!canManage || busy || (change?.kind === "activate" && !trusted)}
              onClick={() => {
                if (change && canManage && !busy && (change.kind === "deactivate" || trusted))
                  mutation.mutate(change);
              }}
            >
              <Check />
              {t(
                change?.kind === "activate"
                  ? "recipes.confirmActivation"
                  : "recipes.confirmDeactivation",
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
