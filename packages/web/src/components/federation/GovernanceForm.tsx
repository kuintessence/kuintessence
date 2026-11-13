import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { disclosureChoices, type GovernanceKind, governanceSchemas } from "./governance-policy";

type Selections = Record<string, string[]>;
export function GovernanceForm({
  kind,
  disabled,
  onDraft,
}: {
  kind: GovernanceKind;
  disabled: boolean;
  onDraft: (input: unknown) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({
    maxChargedAmount: "0",
    recordType: "bill",
  });
  const [selected, setSelected] = useState<Selections>({});
  const [required, setRequired] = useState<Selections>({});
  const [subjects, setSubjects] = useState<string[]>(["bill"]);
  const [actions, setActions] = useState<string[]>(["resolve-without-financial-change"]);
  const [invalid, setInvalid] = useState(false);
  const toggle = (items: string[], value: string) =>
    items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  const field = (name: string, type = "text") => (
    <label className="grid gap-1 text-sm" htmlFor={`${id}-${name}`}>
      {t(`federation.governance.fields.${name}`)}
      <Input
        id={`${id}-${name}`}
        type={type}
        value={values[name] ?? ""}
        onChange={(event) => setValues({ ...values, [name]: event.target.value })}
        required
      />
    </label>
  );
  const selections = (value: Selections) =>
    Object.entries(value)
      .filter(([, fields]) => fields.length)
      .map(([recordType, fields]) => ({ recordType, fields }));
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const common = { validUntil: new Date(values.validUntil ?? "").toISOString() };
          const input =
            kind === "arbitration"
              ? {
                  ...common,
                  policyId: crypto.randomUUID(),
                  arbitratorSiteId: values.recipientSiteId,
                  subjectTypes: subjects,
                  disclosures: selections(selected),
                  requiredEvidence: selections(required),
                  decisionRule: "designated-arbitrator",
                  actions,
                  maxChargedAmount: values.maxChargedAmount,
                }
              : kind === "disclosure"
                ? {
                    ...common,
                    policyId: crypto.randomUUID(),
                    recipientSiteId: values.recipientSiteId,
                    disclosures: selections(selected),
                  }
                : kind === "grant"
                  ? {
                      ...common,
                      grantId: crypto.randomUUID(),
                      caseId: values.caseId,
                      policyId: values.policyId,
                      recordType: values.recordType,
                      recordId: values.recordId,
                      recordDigest: values.recordDigest,
                      fields: selected[values.recordType ?? "bill"] ?? [],
                    }
                  : {
                      ...common,
                      publicationId: crypto.randomUUID(),
                      caseDomainId: values.caseDomainId,
                      grantId: values.grantId,
                    };
          onDraft(governanceSchemas[kind].draft.parse(input));
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <fieldset disabled={disabled} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {kind === "arbitration" || kind === "disclosure" ? field("recipientSiteId") : null}
          {kind === "grant" ? (
            <>
              {field("caseId")}
              {field("policyId")}
              {field("recordId")}
              {field("recordDigest")}
              <label className="grid gap-1 text-sm" htmlFor={`${id}-recordType`}>
                {t("federation.governance.fields.recordType")}
                <NativeSelect
                  id={`${id}-recordType`}
                  aria-label={t("federation.governance.fields.recordType")}
                  value={values.recordType}
                  onChange={(event) => setValues({ ...values, recordType: event.target.value })}
                >
                  {disclosureChoices.map(({ recordType }) => (
                    <option key={recordType} value={recordType}>
                      {t(`federation.governance.records.${recordType}`)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </>
          ) : null}
          {kind === "publication" ? (
            <>
              {field("caseDomainId")}
              {field("grantId")}
            </>
          ) : null}
          {field("validUntil", "datetime-local")}
          {kind === "arbitration" ? field("maxChargedAmount") : null}
        </div>
        {kind === "arbitration" ? (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {t("federation.governance.subjects")}
              </legend>
              <div className="flex flex-wrap gap-4">
                {disclosureChoices
                  .filter((c) => c.recordType !== "agreement")
                  .map(({ recordType }) => (
                    <label className="flex items-center gap-2 text-sm" key={recordType}>
                      <input
                        type="checkbox"
                        checked={subjects.includes(recordType)}
                        onChange={() => setSubjects(toggle(subjects, recordType))}
                      />
                      {t(`federation.governance.records.${recordType}`)}
                    </label>
                  ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {t("federation.governance.actions")}
              </legend>
              <div className="flex flex-wrap gap-4">
                {["resolve-without-financial-change", "settle", "adjust"].map((action) => (
                  <label className="flex items-center gap-2 text-sm" key={action}>
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={() => setActions(toggle(actions, action))}
                    />
                    {t(`federation.governance.outcomes.${action}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        {kind !== "publication" ? (
          <fieldset className="space-y-4">
            <legend className="mb-3 text-sm font-medium">
              {t("federation.governance.allowedFields")}
            </legend>
            {disclosureChoices
              .filter((choice) => kind !== "grant" || choice.recordType === values.recordType)
              .map(({ recordType, fields }) => (
                <fieldset key={recordType} className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    {t(`federation.governance.records.${recordType}`)}
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {fields.map((name) => (
                      <div className="flex flex-wrap items-center gap-3 text-sm" key={name}>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected[recordType]?.includes(name) ?? false}
                            onChange={() => {
                              const next = toggle(selected[recordType] ?? [], name);
                              setSelected({ ...selected, [recordType]: next });
                              if (!next.includes(name))
                                setRequired({
                                  ...required,
                                  [recordType]: (required[recordType] ?? []).filter(
                                    (f) => f !== name,
                                  ),
                                });
                            }}
                          />
                          {t(`federation.governance.disclosureFields.${name}`)}
                        </label>
                        {kind === "arbitration" && selected[recordType]?.includes(name) ? (
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={required[recordType]?.includes(name) ?? false}
                              onChange={() =>
                                setRequired({
                                  ...required,
                                  [recordType]: toggle(required[recordType] ?? [], name),
                                })
                              }
                            />
                            {t("federation.governance.required")}
                          </label>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
          </fieldset>
        ) : null}
        {invalid ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.governance.invalid")}
          </p>
        ) : null}
        <Button type="submit">{t("federation.governance.preview")}</Button>
      </fieldset>
    </form>
  );
}
