import {
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
} from "@kuintessence/shared/browser";
import { Loader2, Search, Square } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MaterialVisibilityForm } from "./MaterialVisibilityForm";
import { MaterialVisibilityHistory } from "./MaterialVisibilityHistory";
import { useMaterialVisibility } from "./use-material-visibility";

export function MaterialVisibility({
  initialBinding,
  isCurrent,
  canWriteRepository,
  canInspectRepository,
  onInvalidate,
  onSelectionLockChange,
}: {
  initialBinding?: SpackMaterialBinding;
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
  canInspectRepository: (repository: string) => boolean;
  onInvalidate: () => void;
  onSelectionLockChange?: (locked: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [repositoryId, setRepositoryId] = useState(initialBinding?.repositoryId ?? "");
  const [manifestDigest, setManifestDigest] = useState(initialBinding?.manifestDigest ?? "");
  const visibility = useMaterialVisibility({
    isCurrent,
    canWriteRepository,
    canInspectRepository,
    onInvalidate,
    onSelectionLockChange,
  });
  const { view, busy, notice, locked } = visibility;
  const binding = SpackMaterialBindingSchema.safeParse({ repositoryId, manifestDigest });
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border py-3"
      data-testid="material-visibility"
    >
      <h3 className="text-xs font-medium">{t("materials.visibilityTitle")}</h3>
      <form
        className="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (binding.success && !busy) void visibility.inspect(binding.data);
        }}
      >
        <label htmlFor={`${id}-repository`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.visibilityRepositoryId")}</span>
          <Input
            id={`${id}-repository`}
            className="font-mono"
            value={repositoryId}
            disabled={locked}
            onChange={(event) => {
              if (visibility.reset()) setRepositoryId(event.target.value);
            }}
          />
        </label>
        <label htmlFor={`${id}-digest`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.visibilityManifestDigest")}</span>
          <Input
            id={`${id}-digest`}
            className="font-mono"
            value={manifestDigest}
            disabled={locked}
            onChange={(event) => {
              if (visibility.reset()) setManifestDigest(event.target.value);
            }}
          />
        </label>
        <Button
          type="submit"
          size="icon"
          variant="outline"
          disabled={!binding.success || !!busy}
          title={t("materials.visibilityInspect")}
          aria-label={t("materials.visibilityInspect")}
        >
          {busy === "read" ? <Loader2 className="animate-spin" /> : <Search />}
        </Button>
      </form>
      {busy ? (
        <div className="flex items-center gap-2 text-xs">
          <span role="status">{t(`materials.visibilityBusy.${busy}`)}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title={t("materials.visibilityStop")}
            aria-label={t("materials.visibilityStop")}
            onClick={visibility.stop}
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
          {t(`materials.visibilityNotice.${notice}`)}
        </p>
      ) : null}
      {view ? (
        <div className="min-w-0 space-y-3" data-testid="material-visibility-detail">
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t("materials.repository")}</dt>
              <dd className="break-all font-mono">{view.repository}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("materials.visibilityPolicy")}</dt>
              <dd>{t(`materials.visibilityMode.${view.policy.mode}`)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("materials.lifecycleRevision")}</dt>
              <dd className="tabular-nums">{view.revision}</dd>
            </div>
          </dl>
          <MaterialVisibilityForm
            key={view.revision}
            view={view}
            canWrite={isCurrent() && canWriteRepository(view.repository)}
            onChange={visibility.change}
          />
          <MaterialVisibilityHistory key={view.revision} view={view} />
        </div>
      ) : null}
    </section>
  );
}
