import { FederationAssetRefSchema } from "@kuintessence/shared/federation";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { type AssetAction, AssetMaterialSchema, materialDigest } from "./asset-material";

export function FederationAssetImport({
  kind,
  disabled,
  onReview,
  onCancel,
}: {
  kind: "material" | "mapping";
  disabled: boolean;
  onReview: (action: AssetAction) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const sequence = useRef(0);
  const allowed = useRef(!disabled);
  allowed.current = !disabled;
  useEffect(
    () => () => {
      allowed.current = false;
      sequence.current++;
    },
    [],
  );
  const [origin, setOrigin] = useState("");
  const [json, setJson] = useState("");
  const [reference, setReference] = useState({ kind: "script", id: "", revision: "", digest: "" });
  const [localRevision, setLocalRevision] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busy = disabled || working;
  return (
    <form
      className="max-w-3xl space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const current = ++sequence.current;
        setError(null);
        setWorking(true);
        try {
          if (kind === "mapping") {
            const parsed = FederationAssetRefSchema.parse({ ...reference, originSiteId: origin });
            const localRevisionId = z.uuid().parse(localRevision);
            if (allowed.current) onReview({ kind, reference: parsed, localRevisionId });
          } else {
            const originSiteId = z.uuid().parse(origin);
            if (new TextEncoder().encode(json).length > 1048576) {
              setError(t("federation.assets.tooLarge"));
              return;
            }
            const raw: unknown = JSON.parse(json);
            // Bound JSON depth and size before recursive schema validation.
            const digest = await materialDigest(raw);
            const content = AssetMaterialSchema.parse(raw);
            if (current === sequence.current && allowed.current)
              onReview({ kind, originSiteId, content, digest });
          }
        } catch {
          if (current === sequence.current) setError(t("federation.assets.invalid"));
        } finally {
          if (current === sequence.current) setWorking(false);
        }
      }}
    >
      <h3 className="font-semibold">{t(`federation.assets.add.${kind}`)}</h3>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm" htmlFor={`${id}-origin`}>
          <span>{t("federation.assets.origin")}</span>
          <Input
            id={`${id}-origin`}
            required
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </label>
        {kind === "material" ? (
          <>
            <label className="block space-y-1 text-sm" htmlFor={`${id}-file`}>
              <span>{t("federation.assets.file")}</span>
              <Input
                id={`${id}-file`}
                type="file"
                accept=".json,application/json"
                onChange={async (event) => {
                  const current = ++sequence.current;
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setError(null);
                  setJson("");
                  if (file.size > 1048576) {
                    setError(t("federation.assets.tooLarge"));
                    return;
                  }
                  try {
                    const text = await file.text();
                    if (current === sequence.current && allowed.current) setJson(text);
                  } catch {
                    if (current === sequence.current) setError(t("federation.assets.readFailed"));
                  }
                }}
              />
            </label>
            <label className="block space-y-1 text-sm" htmlFor={`${id}-content`}>
              <span>{t("federation.assets.content")}</span>
              <Textarea
                id={`${id}-content`}
                required
                rows={10}
                maxLength={1048576}
                className="font-mono text-xs"
                value={json}
                onChange={(e) => {
                  sequence.current++;
                  setJson(e.target.value);
                }}
              />
            </label>
          </>
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <label className="block min-w-0 space-y-1 text-sm" htmlFor={`${id}-kind`}>
              <span>{t("federation.assets.kind")}</span>
              <select
                id={`${id}-kind`}
                className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
                value={reference.kind}
                onChange={(e) => setReference({ ...reference, kind: e.target.value })}
              >
                {FederationAssetRefSchema.shape.kind.options.map((value) => (
                  <option key={value} value={value}>
                    {t(`federation.tasks.kinds.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            {(["id", "revision", "digest"] as const).map((field) => (
              <label
                key={field}
                className="block min-w-0 space-y-1 text-sm"
                htmlFor={`${id}-${field}`}
              >
                <span>{t(`federation.assets.${field}`)}</span>
                <Input
                  id={`${id}-${field}`}
                  required
                  value={reference[field]}
                  onChange={(e) => setReference({ ...reference, [field]: e.target.value })}
                />
              </label>
            ))}
            <label
              className="block min-w-0 space-y-1 text-sm sm:col-span-2"
              htmlFor={`${id}-local`}
            >
              <span>{t("federation.assets.localRevision")}</span>
              <Input
                id={`${id}-local`}
                required
                value={localRevision}
                onChange={(e) => setLocalRevision(e.target.value)}
              />
            </label>
          </div>
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={busy} type="submit">
          {t(working ? "federation.loading" : "federation.assets.review")}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </form>
  );
}
