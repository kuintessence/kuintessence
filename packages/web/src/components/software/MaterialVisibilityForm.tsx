import {
  SpackMaterialVisibilityChangeSchema,
  type SpackMaterialVisibilityPolicy,
  type SpackMaterialVisibilityView,
} from "@kuintessence/shared/browser";
import { Save } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

function ids(value: string): string[] {
  return value.trim() === "" ? [] : value.trim().split(/\s+/);
}

export function MaterialVisibilityForm({
  view,
  canWrite,
  onChange,
}: {
  view: SpackMaterialVisibilityView;
  canWrite: boolean;
  onChange: (policy: SpackMaterialVisibilityPolicy, reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [mode, setMode] = useState(view.policy.mode);
  const [userIds, setUserIds] = useState(
    view.policy.mode === "allowlist" ? view.policy.userIds.join("\n") : "",
  );
  const [orgIds, setOrgIds] = useState(
    view.policy.mode === "allowlist" ? view.policy.orgIds.join("\n") : "",
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const policy = SpackMaterialVisibilityChangeSchema.shape.policy.safeParse(
    mode === "inherit" ? { mode } : { mode, userIds: ids(userIds), orgIds: ids(orgIds) },
  );
  const validReason = SpackMaterialVisibilityChangeSchema.shape.reason.safeParse(reason).success;
  const validRevision = SpackMaterialVisibilityChangeSchema.shape.expectedRevision.safeParse(
    view.revision,
  ).success;
  const changed = policy.success && JSON.stringify(policy.data) !== JSON.stringify(view.policy);
  const canChange =
    canWrite && policy.success && validReason && validRevision && confirmed && changed;
  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canChange || !policy.success) return;
        setConfirmed(false);
        void onChange(policy.data, reason);
      }}
    >
      <label htmlFor={`${id}-mode`} className="block space-y-1 text-xs">
        <span id={`${id}-mode-label`}>{t("materials.visibilityPolicy")}</span>
        <select
          id={`${id}-mode`}
          aria-labelledby={`${id}-mode-label`}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={mode}
          disabled={!canWrite}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "inherit" || value === "allowlist") {
              setMode(value);
              setConfirmed(false);
            }
          }}
        >
          <option value="inherit">{t("materials.visibilityMode.inherit")}</option>
          <option value="allowlist">{t("materials.visibilityMode.allowlist")}</option>
        </select>
      </label>
      {mode === "allowlist" ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {[
            { key: "userIds", value: userIds, set: setUserIds },
            { key: "orgIds", value: orgIds, set: setOrgIds },
          ].map((field) => (
            <label
              key={field.key}
              htmlFor={`${id}-${field.key}`}
              className="min-w-0 space-y-1 text-xs"
            >
              <span>{t(`materials.visibilityPrincipals.${field.key}`)}</span>
              <textarea
                id={`${id}-${field.key}`}
                className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent p-2 font-mono text-sm"
                rows={3}
                maxLength={4000}
                value={field.value}
                disabled={!canWrite}
                aria-invalid={!policy.success}
                aria-describedby={!policy.success ? `${id}-invalid-policy` : undefined}
                onChange={(event) => {
                  field.set(event.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      {!policy.success ? (
        <p id={`${id}-invalid-policy`} className="text-xs text-status-failed">
          {t("materials.visibilityInvalidPolicy")}
        </p>
      ) : null}
      {mode === "allowlist" && ids(userIds).length === 0 && ids(orgIds).length === 0 ? (
        <p role="status" className="text-xs text-status-failed">
          {t("materials.visibilityDenyAll")}
        </p>
      ) : null}
      <label htmlFor={`${id}-reason`} className="block space-y-1 text-xs">
        <span>{t("materials.visibilityReason")}</span>
        <textarea
          id={`${id}-reason`}
          className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm"
          rows={2}
          maxLength={1000}
          value={reason}
          disabled={!canWrite}
          aria-invalid={reason !== "" && !validReason}
          aria-describedby={reason !== "" && !validReason ? `${id}-invalid-reason` : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      {reason !== "" && !validReason ? (
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
        <span>{t("materials.visibilityConfirm")}</span>
      </label>
      <Button type="submit" variant="outline" disabled={!canChange}>
        <Save />
        {t("materials.visibilitySave")}
      </Button>
    </form>
  );
}
