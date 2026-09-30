import {
  type SpackInstallBindingChange,
  SpackInstallBindingChangeSchema,
  type SpackInstallBindingView,
  type SpackMaterialBinding,
} from "@kuintessence/shared/browser";
import { ClipboardCopy, Save } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { sameInstallBinding } from "../../lib/spack-install-bindings-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function SpackInstallBindingForm({
  view,
  selection,
  canWrite,
  onChange,
}: {
  view: SpackInstallBindingView;
  selection?: SpackMaterialBinding;
  canWrite: boolean;
  onChange: (command: SpackInstallBindingChange) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [action, setAction] = useState<"bind" | "disable">("bind");
  const [repositoryId, setRepositoryId] = useState(
    view.binding?.repositoryId ?? selection?.repositoryId ?? "",
  );
  const [manifestDigest, setManifestDigest] = useState(
    view.binding?.manifestDigest ?? selection?.manifestDigest ?? "",
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const binding = { repositoryId, manifestDigest };
  const command = SpackInstallBindingChangeSchema.safeParse({
    scope: view.scope,
    spec: view.spec,
    expectedRevision: view.revision,
    reason,
    action,
    ...(action === "bind" ? { binding } : {}),
  });
  const changed =
    action === "disable"
      ? view.state !== "disabled"
      : view.state !== "enabled" || !sameInstallBinding(binding, view.binding);
  const canSubmit = canWrite && changed && confirmed && command.success;
  const invalidReason =
    reason !== "" &&
    !command.success &&
    command.error.issues.some((issue) => issue.path[0] === "reason");
  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit || !command.success) return;
        setConfirmed(false);
        void onChange(command.data);
      }}
    >
      <label htmlFor={`${id}-action`} className="block space-y-1 text-xs">
        <span>{t("materials.installBinding.action")}</span>
        <select
          id={`${id}-action`}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={action}
          disabled={!canWrite}
          onChange={(event) => {
            if (event.target.value === "bind" || event.target.value === "disable") {
              setAction(event.target.value);
              setConfirmed(false);
            }
          }}
        >
          <option value="bind">{t("materials.installBinding.bind")}</option>
          <option value="disable">{t("materials.installBinding.disable")}</option>
        </select>
      </label>
      {action === "bind" ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {[
            { key: "repositoryId", value: repositoryId, set: setRepositoryId, max: 64 },
            { key: "manifestDigest", value: manifestDigest, set: setManifestDigest, max: 71 },
          ].map((field) => (
            <label key={field.key} htmlFor={`${id}-${field.key}`} className="min-w-0 text-xs">
              <span>{t(`materials.installBinding.${field.key}`)}</span>
              <Input
                id={`${id}-${field.key}`}
                className="font-mono"
                value={field.value}
                maxLength={field.max}
                disabled={!canWrite}
                onChange={(event) => {
                  field.set(event.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
          ))}
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={!canWrite || !selection}
            title={t("materials.installBinding.useSelection")}
            aria-label={t("materials.installBinding.useSelection")}
            onClick={() => {
              if (!canWrite || !selection) return;
              setRepositoryId(selection.repositoryId);
              setManifestDigest(selection.manifestDigest);
              setConfirmed(false);
            }}
          >
            <ClipboardCopy />
          </Button>
        </div>
      ) : null}
      <label htmlFor={`${id}-reason`} className="block space-y-1 text-xs">
        <span>{t("materials.installBinding.reason")}</span>
        <textarea
          id={`${id}-reason`}
          className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
          rows={2}
          maxLength={1000}
          value={reason}
          disabled={!canWrite}
          aria-invalid={invalidReason}
          aria-describedby={invalidReason ? `${id}-invalid-reason` : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      {invalidReason ? (
        <p id={`${id}-invalid-reason`} className="text-xs text-status-failed">
          {t("materials.lifecycleInvalidReason")}
        </p>
      ) : null}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={confirmed}
          disabled={!canWrite}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>{t("materials.installBinding.confirm")}</span>
      </label>
      <Button type="submit" variant="outline" disabled={!canSubmit}>
        <Save />
        {t("materials.installBinding.save")}
      </Button>
    </form>
  );
}
