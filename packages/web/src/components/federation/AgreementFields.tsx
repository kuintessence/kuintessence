import { FederationAgreementSchema } from "@kuintessence/shared/federation";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";

type Field = {
  type: string;
  const?: number | string;
  enum?: string[];
  properties?: Record<string, Field>;
  required?: string[];
  items?: Field;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};
type Value = string | number | Value[] | Draft;
export interface Draft {
  [key: string]: Value;
}

const schema = z.toJSONSchema(FederationAgreementSchema) as Field;
function initial(field: Field): Value {
  if (field.const !== undefined) return field.const;
  if (field.enum) return field.enum[0] ?? "";
  if (field.items) {
    const item = field.items;
    return Array.from({ length: field.minItems ?? 0 }, () => initial(item));
  }
  if (field.properties) {
    const entries = Object.entries(field.properties).filter(([name]) =>
      field.required?.includes(name),
    );
    return Object.fromEntries(entries.map(([name, child]) => [name, initial(child)]));
  }
  return "";
}

export function newAgreementDraft(siteId: string): Draft {
  return {
    ...(initial(schema) as Draft),
    sourceSiteId: siteId,
    agreementRevisionId: crypto.randomUUID(),
  };
}

export function AgreementFields({
  draft,
  onChange,
  supportedModes,
  disabled,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  supportedModes: readonly string[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  function render(
    name: string,
    field: Field,
    value: Value,
    update: (value: Value) => void,
    path: string,
  ) {
    const label = t(`federation.agreements.fields.${name}`);
    if (field.const !== undefined) return null;
    if (field.items && Array.isArray(value)) {
      const item = field.items;
      return (
        <fieldset className="space-y-3">
          <legend className="font-medium">{label}</legend>
          {value.map((row, index) => {
            const location = `${path}.${index}`;
            return (
              <fieldset key={location} className="space-y-2 border-l border-border pl-3">
                <legend>
                  {label} {index + 1}
                </legend>
                {renderObject(
                  item,
                  row as Draft,
                  (next) => update(value.map((v, i) => (i === index ? next : v))),
                  location,
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={value.length <= (field.minItems ?? 0)}
                  onClick={() => update(value.filter((_, i) => i !== index))}
                >
                  {t("federation.agreements.removeRow", { number: index + 1 })}
                </Button>
              </fieldset>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={value.length >= (field.maxItems ?? Infinity)}
            onClick={() => update([...value, initial(item)])}
          >
            {t("federation.agreements.addRow", { name: label })}
          </Button>
        </fieldset>
      );
    }
    if (field.properties)
      return (
        <fieldset className="space-y-2">
          <legend className="font-medium">{label}</legend>
          {renderObject(field, value as Draft, update, path)}
        </fieldset>
      );
    if (field.enum) {
      const options = name === "kind" ? ["workflow", "script"] : field.enum;
      return (
        <label className="grid gap-1">
          {label}
          <NativeSelect value={String(value)} onChange={(e) => update(e.target.value)}>
            {options.map((option) => (
              <option
                key={option}
                value={option}
                disabled={name === "mode" && !supportedModes.includes(option)}
              >
                {name === "mode" ? t(`federation.agreements.modes.${option}`) : option}
              </option>
            ))}
          </NativeSelect>
        </label>
      );
    }
    const numeric = field.type === "integer";
    return (
      <label className="grid gap-1">
        {label}
        <Input
          name={path}
          type={numeric ? "number" : "text"}
          min={field.minimum}
          max={field.maximum}
          maxLength={field.maxLength}
          value={String(value)}
          onChange={(e) =>
            update(numeric && e.target.value !== "" ? e.target.valueAsNumber : e.target.value)
          }
        />
      </label>
    );
  }
  function renderObject(
    field: Field,
    object: Draft,
    update: (value: Draft) => void,
    parent: string,
  ): React.ReactNode {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(field.properties ?? {}).map(([name, child]) => {
          if (
            child.const !== undefined ||
            (name === "attestationLimits" && draft.mode !== "bilateral_attested")
          )
            return null;
          const path = parent ? `${parent}.${name}` : name;
          const change = (value: Value) => {
            const next = { ...object, [name]: value };
            if (name === "mode" && value !== "bilateral_attested") delete next.attestationLimits;
            update(next);
          };
          const optional = !field.required?.includes(name);
          return (
            <div
              key={name}
              className={child.items || child.properties ? "space-y-2 sm:col-span-2" : undefined}
            >
              {optional ? (
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={object[name] !== undefined}
                    onChange={(e) => {
                      if (e.target.checked) change(initial(child));
                      else {
                        const next = { ...object };
                        delete next[name];
                        update(next);
                      }
                    }}
                  />
                  {t("federation.agreements.enableField", {
                    name: t(`federation.agreements.fields.${name}`),
                  })}
                </label>
              ) : null}
              {object[name] !== undefined && render(name, child, object[name], change, path)}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <fieldset disabled={disabled} className="space-y-3 text-sm">
      {renderObject(schema, draft, onChange, "")}
    </fieldset>
  );
}
