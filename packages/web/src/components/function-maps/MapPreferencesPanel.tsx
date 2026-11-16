import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { MapPreferenceFields } from "./MapPreferenceFields";
import { type MapPreferences, useMapPreferences } from "./preferences";

export function MapPreferencesPanel() {
  const { t } = useTranslation();
  const { prefs, update } = useMapPreferences();
  const [draft, setDraft] = useState(prefs);
  function appearance(patch: Partial<MapPreferences["appearance"]>) {
    setDraft((current) => ({ ...current, appearance: { ...current.appearance, ...patch } }));
  }
  return (
    <form
      className="space-y-6 border-t border-border pt-5"
      aria-label={t("functionMaps.preferences.title")}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          update((current) => ({
            ...current,
            appearance: draft.appearance,
            dual: draft.dual,
            single: draft.single,
          }));
          toast.success(t("functionMaps.preferences.saved"));
        } catch {
          toast.error(t("functionMaps.preferences.saveFailed"));
        }
      }}
    >
      <div>
        <h3 className="text-base font-semibold">{t("functionMaps.preferences.title")}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t("functionMaps.preferences.scope")}</p>
      </div>
      <fieldset className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold">{t("functionMaps.appearance")}</legend>
        <label className="flex flex-col gap-2 text-sm">
          <span>{t("functionMaps.connection")}</span>
          <NativeSelect
            value={draft.appearance.flow ? "flow" : "static"}
            onChange={(event) => appearance({ flow: event.target.value === "flow" })}
          >
            <option value="static">{t("functionMaps.static")}</option>
            <option value="flow">{t("functionMaps.flow")}</option>
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span>{t("functionMaps.lineColor")}</span>
          <NativeSelect
            value={draft.appearance.color}
            onChange={(event) =>
              appearance({ color: event.target.value as MapPreferences["appearance"]["color"] })
            }
          >
            <option value="muted-foreground">{t("functionMaps.neutral")}</option>
            <option value="brand">{t("functionMaps.brand")}</option>
            <option value="foreground">{t("functionMaps.contrast")}</option>
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="flex justify-between">
            {t("functionMaps.lineWidth")}
            <output>{draft.appearance.lineWidth} px</output>
          </span>
          <input
            className="function-map-range w-full"
            type="range"
            min="1"
            max="3"
            step="0.5"
            value={draft.appearance.lineWidth}
            onChange={(event) => appearance({ lineWidth: Number(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="flex justify-between">
            {t("functionMaps.flowDuration")}
            <output>{draft.appearance.duration} s</output>
          </span>
          <input
            className="function-map-range w-full"
            type="range"
            min="1"
            max="5"
            step="0.5"
            disabled={!draft.appearance.flow}
            value={draft.appearance.duration}
            onChange={(event) => appearance({ duration: Number(event.target.value) })}
          />
        </label>
      </fieldset>
      <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
        {(["dual", "single"] as const).map((presentation) => (
          <section key={presentation} className="space-y-3">
            <h4 className="text-sm font-semibold">
              {t(`functionMaps.preferences.${presentation}`)}
            </h4>
            <MapPreferenceFields
              presentation={presentation}
              value={draft[presentation]}
              onChange={(value) => setDraft((current) => ({ ...current, [presentation]: value }))}
            />
          </section>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("functionMaps.preferences.overrides")}</p>
      <div className="flex items-center gap-3">
        <Button type="submit">{t("common.save")}</Button>
        <span role="status" className="text-xs text-muted-foreground">
          {t("functionMaps.preferences.nextEntry")}
        </span>
      </div>
    </form>
  );
}
