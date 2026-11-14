import {
  type FederationAgreementApproval,
  type FederationClusterProfile,
  FederationClusterProfileSchema,
} from "@kuintessence/shared/federation";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";

export function FederationClusterProfiles({
  value,
  onChange,
  agreement,
  materials,
}: {
  value: FederationClusterProfile[];
  onChange: (profiles: FederationClusterProfile[]) => void;
  agreement?: FederationAgreementApproval;
  materials: Array<{ digest: string; kind: string }>;
}) {
  const { t } = useTranslation();
  function patch(index: number, change: Partial<FederationClusterProfile>) {
    onChange(value.map((profile, i) => (i === index ? { ...profile, ...change } : profile)));
  }
  function add() {
    const template = agreement?.terms.templates[0];
    if (!template) return;
    onChange([
      ...value,
      {
        id: crypto.randomUUID(),
        name: "",
        source: { kind: "command", commandParameter: "command" },
        template,
        inputManifestDigest: "",
        environmentLockDigest: "",
        maxAmount: "0",
        outputs: [],
        ...(agreement?.terms.mode === "ledger_coordinated"
          ? { market: { policyId: "", title: "", description: "" } }
          : {}),
      },
    ]);
  }
  return (
    <section className="space-y-4" aria-label={t("federation.clusters.executionProfiles")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{t("federation.clusters.executionProfiles")}</h3>
        <Button type="button" size="sm" variant="outline" disabled={!agreement} onClick={add}>
          <Plus className="size-4" />
          {t("federation.clusters.addProfile")}
        </Button>
      </div>
      {value.map((profile, index) => (
        <fieldset key={profile.id} className="space-y-4 border-t pt-4">
          <legend className="sr-only">
            {profile.name || t("federation.clusters.executionProfiles")}
          </legend>
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">
              {t("federation.clusters.profileName")}
              <Input
                value={profile.name}
                onChange={(event) => patch(index, { name: event.target.value })}
                required
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              {t("federation.clusters.sourceKind")}
              <NativeSelect
                className="w-full"
                value={profile.source.kind}
                onChange={(event) => {
                  const kind = event.target.value as FederationClusterProfile["source"]["kind"];
                  patch(index, {
                    source:
                      kind === "command"
                        ? { kind, commandParameter: "command" }
                        : { kind, revisionId: "" },
                  });
                }}
              >
                {["command", "usecase", "script"].map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`federation.clusters.sourceKinds.${kind}`)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {profile.source.kind === "command" ? (
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.commandParameter")}
                <Input
                  value={profile.source.commandParameter}
                  onChange={(event) =>
                    patch(index, {
                      source: { kind: "command", commandParameter: event.target.value },
                    })
                  }
                  required
                />
              </label>
            ) : (
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.sourceRevision")}
                <Input
                  value={profile.source.revisionId}
                  onChange={(event) => {
                    if (profile.source.kind !== "command")
                      patch(index, {
                        source: { ...profile.source, revisionId: event.target.value },
                      });
                  }}
                  required
                />
              </label>
            )}
            <label className="space-y-1.5 text-sm font-medium">
              {t("federation.clusters.template")}
              <NativeSelect
                className="w-full"
                value={JSON.stringify(profile.template)}
                onChange={(event) => {
                  const template = agreement?.terms.templates.find(
                    (ref) => JSON.stringify(ref) === event.target.value,
                  );
                  if (template) patch(index, { template });
                }}
                required
              >
                {agreement?.terms.templates.map((ref) => (
                  <option key={`${ref.id}:${ref.revision}`} value={JSON.stringify(ref)}>
                    {ref.kind} · {ref.id} · {ref.revision}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {(["inputManifestDigest", "environmentLockDigest"] as const).map((key) => (
              <label key={key} className="space-y-1.5 text-sm font-medium">
                {t(`federation.clusters.${key}`)}
                <Input
                  list={`materials-${profile.id}-${key}`}
                  value={profile[key]}
                  onChange={(event) => patch(index, { [key]: event.target.value })}
                  required
                />
                <datalist id={`materials-${profile.id}-${key}`}>
                  {materials
                    .filter(
                      (material) =>
                        material.kind ===
                        (key === "inputManifestDigest" ? "inputs" : "environment-lock"),
                    )
                    .map((material) => (
                      <option key={material.digest} value={material.digest} />
                    ))}
                </datalist>
              </label>
            ))}
            <label className="space-y-1.5 text-sm font-medium">
              {t("federation.clusters.profileAllowance")}
              <Input
                value={profile.maxAmount}
                inputMode="numeric"
                pattern="0|[1-9][0-9]{0,37}"
                onChange={(event) => patch(index, { maxAmount: event.target.value })}
                required
              />
            </label>
          </div>
          {profile.source.kind === "usecase" ? (
            <details className="py-2">
              <summary className="cursor-pointer text-sm font-medium">
                {t("federation.clusters.jobPackage")}
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                  {t("federation.clusters.packageId")}
                  <Input
                    value={profile.source.packageId ?? ""}
                    onChange={(event) => {
                      if (profile.source.kind === "usecase")
                        patch(index, {
                          source: { ...profile.source, packageId: event.target.value || undefined },
                        });
                    }}
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  {t("federation.clusters.packageDigest")}
                  <Input
                    value={profile.source.packageDigest ?? ""}
                    onChange={(event) => {
                      if (profile.source.kind === "usecase")
                        patch(index, {
                          source: {
                            ...profile.source,
                            packageDigest: event.target.value || undefined,
                          },
                        });
                    }}
                  />
                </label>
              </div>
            </details>
          ) : null}
          {agreement?.terms.mode === "ledger_coordinated" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.marketPolicy")}
                <Input
                  value={profile.market?.policyId ?? ""}
                  onChange={(event) =>
                    patch(index, {
                      market: {
                        policyId: event.target.value,
                        title: profile.market?.title ?? "",
                        description: profile.market?.description ?? "",
                      },
                    })
                  }
                  required
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.marketTitle")}
                <Input
                  value={profile.market?.title ?? ""}
                  onChange={(event) =>
                    patch(index, {
                      market: {
                        policyId: profile.market?.policyId ?? "",
                        title: event.target.value,
                        description: profile.market?.description ?? "",
                      },
                    })
                  }
                  required
                />
              </label>
            </div>
          ) : null}
          <details className="py-2">
            <summary className="cursor-pointer text-sm font-medium">
              {t("federation.clusters.outputMappings")}
            </summary>
            <textarea
              aria-label={t("federation.clusters.outputMappings")}
              className="mt-3 min-h-32 w-full rounded-md border bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              defaultValue={JSON.stringify(profile.outputs, null, 2)}
              onBlur={(event) => {
                try {
                  const parsed: unknown = JSON.parse(event.target.value);
                  if (!Array.isArray(parsed)) throw new Error("Expected an array");
                  patch(index, {
                    outputs: FederationClusterProfileSchema.shape.outputs.parse(parsed),
                  });
                  event.target.setCustomValidity("");
                } catch {
                  event.target.setCustomValidity(t("federation.clusters.invalidJson"));
                  event.target.reportValidity();
                }
              }}
              spellCheck={false}
            />
          </details>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(value.filter((p) => p.id !== profile.id))}
          >
            <Trash2 className="size-4" />
            {t("federation.clusters.removeProfile")}
          </Button>
        </fieldset>
      ))}
    </section>
  );
}
