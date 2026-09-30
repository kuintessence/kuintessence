import {
  SpackInstallBindingQuerySchema,
  type SpackMaterialBinding,
} from "@kuintessence/shared/browser";
import { Loader2, Search, Square } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpackInstallBindingForm } from "./SpackInstallBindingForm";
import { SpackInstallBindingHistory } from "./SpackInstallBindingHistory";
import { useSpackInstallBinding } from "./use-spack-install-binding";

export function SpackInstallBindingEditor({
  organizationId,
  selection,
  isCurrent,
  canInspectScope,
  canWriteScope,
}: {
  organizationId: string | null;
  selection?: SpackMaterialBinding;
  isCurrent: () => boolean;
  canInspectScope: (scope: string) => boolean;
  canWriteScope: (scope: string) => boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [scope, setScope] = useState(organizationId ?? "platform");
  const [spec, setSpec] = useState("");
  const editor = useSpackInstallBinding({ isCurrent, canInspectScope, canWriteScope });
  const { view, busy, notice, locked } = editor;
  const query = SpackInstallBindingQuerySchema.safeParse({ scope, spec });
  const inspectable = isCurrent() && canInspectScope(scope);
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border py-3"
      data-testid="spack-install-binding-editor"
      aria-label={t("materials.installBinding.title")}
    >
      <h3 className="text-xs font-medium">{t("materials.installBinding.title")}</h3>
      <form
        className="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.success && inspectable && !busy) void editor.inspect(query.data);
        }}
      >
        <label htmlFor={`${id}-scope`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.installBinding.scope")}</span>
          <select
            id={`${id}-scope`}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
            value={scope}
            disabled={locked}
            onChange={(event) => {
              const next = event.target.value;
              if (canInspectScope(next) && editor.reset()) setScope(next);
            }}
          >
            {organizationId ? (
              <option value={organizationId}>{organizationId}</option>
            ) : null}
            {canInspectScope("platform") ? (
              <option value="platform">{t("materials.installBinding.platform")}</option>
            ) : null}
          </select>
        </label>
        <label htmlFor={`${id}-spec`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.installBinding.spec")}</span>
          <Input
            id={`${id}-spec`}
            className="font-mono"
            value={spec}
            maxLength={500}
            disabled={locked}
            aria-invalid={spec !== "" && !query.success}
            onChange={(event) => {
              if (editor.reset()) setSpec(event.target.value);
            }}
          />
        </label>
        <Button
          type="submit"
          size="icon"
          variant="outline"
          disabled={!query.success || !inspectable || !!busy}
          title={t("materials.installBinding.inspect")}
          aria-label={t("materials.installBinding.inspect")}
        >
          {busy === "read" ? <Loader2 className="animate-spin" /> : <Search />}
        </Button>
      </form>
      {busy ? (
        <div className="flex items-center gap-2 text-xs">
          <span role="status">{t(`materials.installBinding.busy.${busy}`)}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title={t("materials.installBinding.stop")}
            aria-label={t("materials.installBinding.stop")}
            onClick={editor.stop}
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
          {t(`materials.installBinding.notice.${notice}`)}
        </p>
      ) : null}
      {view ? (
        <div className="min-w-0 space-y-3" data-testid="spack-install-binding-detail">
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt>{t("materials.status")}</dt>
              <dd>{t(`materials.installBinding.state.${view.state}`)}</dd>
            </div>
            <div>
              <dt>{t("materials.lifecycleRevision")}</dt>
              <dd>{view.revision}</dd>
            </div>
            {view.binding ? (
              <div className="min-w-0 sm:col-span-2">
                <dt>{t("materials.installBinding.current")}</dt>
                <dd className="break-all font-mono">{view.binding.repositoryId}</dd>
                <dd className="break-all font-mono">{view.binding.manifestDigest}</dd>
              </div>
            ) : null}
          </dl>
          <SpackInstallBindingForm
            key={`form:${view.revision}`}
            view={view}
            selection={selection}
            canWrite={isCurrent() && canWriteScope(view.scope)}
            onChange={editor.change}
          />
          <SpackInstallBindingHistory key={`history:${view.revision}`} view={view} />
        </div>
      ) : null}
    </section>
  );
}
