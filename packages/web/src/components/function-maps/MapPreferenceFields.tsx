import { useId } from "react";
import { useTranslation } from "react-i18next";
import { NativeSelect } from "../ui/native-select";
import type { MapDisplay, MapPresentation, MapRule } from "./preferences";

export function MapPreferenceFields({
  value,
  presentation,
  onChange,
}: {
  value: MapRule;
  presentation: MapPresentation;
  onChange: (value: MapRule) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const values: MapDisplay[] =
    presentation === "dual" ? ["data", "diagram"] : ["expanded", "collapsed"];
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-3 text-sm font-medium">{t("functionMaps.preferences.mode")}</legend>
      {(["memory", "fixed", "recommended"] as const).map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={id}
            value={mode}
            checked={value.mode === mode}
            className="mt-1 accent-brand"
            onChange={() => onChange({ ...value, mode })}
          />
          <span>{t(`functionMaps.preferences.${mode}`)}</span>
        </label>
      ))}
      {value.mode === "fixed" ? (
        <label className="block space-y-2 text-sm">
          <span>{t("functionMaps.preferences.default")}</span>
          <NativeSelect
            value={values.includes(value.fixed) ? value.fixed : values[0]}
            onChange={(event) => onChange({ ...value, fixed: event.target.value as MapDisplay })}
          >
            {values.map((option) => (
              <option key={option} value={option}>
                {t(`functionMaps.preferences.default_${option}`)}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : null}
    </fieldset>
  );
}
