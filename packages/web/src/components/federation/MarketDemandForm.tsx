import {
  MarketDemandSchema,
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function MarketDemandForm({
  localSiteId,
  disabled,
  onReview,
  onCancel,
}: {
  localSiteId: string;
  disabled: boolean;
  onReview: (input: MarketProposalInput) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const form = new FormData(event.currentTarget);
        const expiresAt = new Date(String(form.get("expiresAt"))).getTime();
        const demand = MarketDemandSchema.safeParse({
          protocolVersion: 1,
          demandId: crypto.randomUUID(),
          sourceSiteId: localSiteId,
          createdAt: new Date().toISOString(),
          expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "",
          title: form.get("title"),
          description: form.get("description"),
          platform: form.get("platform"),
          architecture: form.get("architecture"),
          resources: Object.fromEntries(
            ["cpus", "memoryMb", "gpus", "wallTimeSec"].map((name) => [
              name,
              Number(form.get(name)),
            ]),
          ),
        });
        setInvalid(!demand.success);
        if (demand.success) onReview({ operation: "publish-demand", demand: demand.data });
      }}
    >
      <h3 className="font-semibold">{t("federation.market.publish")}</h3>
      <p className="text-sm text-muted-foreground">{t("federation.market.publicWarning")}</p>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        {[
          "title",
          "platform",
          "architecture",
          "expiresAt",
          "cpus",
          "memoryMb",
          "gpus",
          "wallTimeSec",
        ].map((field) => {
          const numeric = ["cpus", "memoryMb", "gpus", "wallTimeSec"].includes(field);
          return (
            <label
              key={field}
              htmlFor={`${id}-${field}`}
              className={`space-y-1 text-sm ${field === "title" ? "sm:col-span-2" : ""}`}
            >
              <span>{t(`federation.market.fields.${field}`)}</span>
              <Input
                id={`${id}-${field}`}
                name={field}
                required
                type={numeric ? "number" : field === "expiresAt" ? "datetime-local" : "text"}
                min={numeric ? (field === "gpus" ? 0 : 1) : undefined}
                step={numeric ? 1 : undefined}
                maxLength={field === "title" ? 160 : 64}
                defaultValue={
                  numeric ? { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 }[field] : undefined
                }
              />
            </label>
          );
        })}
        <label htmlFor={`${id}-description`} className="space-y-1 text-sm sm:col-span-2">
          <span>{t("federation.market.fields.description")}</span>
          <textarea
            id={`${id}-description`}
            name="description"
            maxLength={4096}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-3"
          />
        </label>
      </fieldset>
      {invalid ? <p role="alert">{t("federation.market.invalid")}</p> : null}
      <div className="flex gap-2">
        <Button disabled={disabled}>{t("federation.market.review")}</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </form>
  );
}
