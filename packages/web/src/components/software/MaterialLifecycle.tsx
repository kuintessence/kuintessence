import {
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  SpackMaterialLifecycleChangeSchema,
} from "@kuintessence/shared/browser";
import { Archive, Loader2, RotateCcw, Search, Square } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MaterialLifecycleHistory } from "./MaterialLifecycleHistory";
import { useMaterialLifecycle } from "./use-material-lifecycle";

export function MaterialLifecycle({
  initialBinding,
  isCurrent,
  canWriteRepository,
  canInspectRepository = canWriteRepository,
  onInvalidate,
  onSelectionLockChange,
}: {
  initialBinding?: SpackMaterialBinding;
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
  canInspectRepository?: (repository: string) => boolean;
  onInvalidate: () => void;
  onSelectionLockChange?: (locked: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [repositoryId, setRepositoryId] = useState(initialBinding?.repositoryId ?? "");
  const [manifestDigest, setManifestDigest] = useState(initialBinding?.manifestDigest ?? "");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const lifecycle = useMaterialLifecycle({
    isCurrent,
    canWriteRepository,
    canInspectRepository,
    onInvalidate,
    onSelectionLockChange,
  });
  const { view, busy, notice } = lifecycle;
  const binding = SpackMaterialBindingSchema.safeParse({ repositoryId, manifestDigest });
  const action = view?.state === "withdrawn" ? "restore" : "withdraw";
  const validReason = SpackMaterialLifecycleChangeSchema.shape.reason.safeParse(reason).success;
  const validChange = SpackMaterialLifecycleChangeSchema.safeParse({
    action,
    expectedRevision: view?.revision,
    reason,
  }).success;
  const canChange =
    view && canWriteRepository(view.repository) && validChange && confirmed && !busy;

  function clearConfirmation() {
    setReason("");
    setConfirmed(false);
  }

  function edit() {
    lifecycle.reset();
    clearConfirmation();
  }

  return (
    <section
      className="min-w-0 space-y-3 border-t border-border py-3"
      data-testid="material-lifecycle"
    >
      <h3 className="text-xs font-medium">{t("materials.lifecycleTitle")}</h3>
      <form
        className="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (binding.success && !busy) {
            clearConfirmation();
            void lifecycle.inspect(binding.data);
          }
        }}
      >
        <label htmlFor={`${id}-repository`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.lifecycleRepositoryId")}</span>
          <Input
            id={`${id}-repository`}
            className="font-mono"
            value={repositoryId}
            disabled={busy === "write"}
            onChange={(event) => {
              edit();
              setRepositoryId(event.target.value);
            }}
          />
        </label>
        <label htmlFor={`${id}-digest`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.lifecycleManifestDigest")}</span>
          <Input
            id={`${id}-digest`}
            className="font-mono"
            value={manifestDigest}
            disabled={busy === "write"}
            onChange={(event) => {
              edit();
              setManifestDigest(event.target.value);
            }}
          />
        </label>
        <Button
          type="submit"
          size="icon"
          variant="outline"
          disabled={!binding.success || !!busy}
          title={t("materials.lifecycleInspect")}
          aria-label={t("materials.lifecycleInspect")}
        >
          {busy === "read" ? <Loader2 className="animate-spin" /> : <Search />}
        </Button>
      </form>
      {busy ? (
        <div className="flex items-center gap-2 text-xs">
          <span role="status">{t(`materials.lifecycleBusy.${busy}`)}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title={t("materials.lifecycleStop")}
            aria-label={t("materials.lifecycleStop")}
            onClick={() => {
              clearConfirmation();
              lifecycle.stop();
            }}
          >
            <Square />
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p
          role={notice === "changed" || notice === "rechecked" ? "status" : "alert"}
          className="break-words text-xs"
        >
          {t(`materials.lifecycleNotice.${notice}`)}
        </p>
      ) : null}
      {view ? (
        <div className="min-w-0 space-y-3" data-testid="material-lifecycle-detail">
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t("materials.repository")}</dt>
              <dd className="break-all font-mono">{view.repository}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("materials.status")}</dt>
              <dd>{t(`materials.lifecycleState.${view.state}`)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("materials.lifecycleRevision")}</dt>
              <dd className="tabular-nums">{view.revision}</dd>
            </div>
          </dl>
          <form
            className="min-w-0 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canChange) return;
              const submittedReason = reason;
              clearConfirmation();
              void lifecycle.change(submittedReason);
            }}
          >
            <label htmlFor={`${id}-reason`} className="block space-y-1 text-xs">
              <span>{t("materials.lifecycleReason")}</span>
              <textarea
                id={`${id}-reason`}
                className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
                rows={2}
                maxLength={1000}
                value={reason}
                disabled={!canWriteRepository(view.repository)}
                aria-invalid={reason.length > 0 && !validReason}
                aria-describedby={reason.length > 0 && !validReason ? `${id}-invalid` : undefined}
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            {reason.length > 0 && !validReason ? (
              <p id={`${id}-invalid`} className="text-xs text-status-failed">
                {t("materials.lifecycleInvalidReason")}
              </p>
            ) : null}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={confirmed}
                disabled={!canWriteRepository(view.repository)}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{t(`materials.lifecycleConfirm.${action}`)}</span>
            </label>
            <Button type="submit" variant="outline" disabled={!canChange}>
              {action === "withdraw" ? <Archive /> : <RotateCcw />}
              {t(`materials.lifecycleAction.${action}`)}
            </Button>
          </form>
          <MaterialLifecycleHistory key={view.revision} view={view} />
        </div>
      ) : null}
    </section>
  );
}
