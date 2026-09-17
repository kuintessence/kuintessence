import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileKey2, ShieldAlert, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  bindRuntimeContract,
  decideLicenseEntitlementClaim,
  type LicenseEntitlementClaim,
  listLicensedMaterialMappings,
  listLicenseEntitlementClaims,
  listRuntimeContractBindings,
  registerLicensedMaterialMapping,
  submitLicenseEntitlementClaim,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";

interface LicenseEntitlementPanelProps {
  canReview: boolean;
  canSubmit: boolean;
  defaultClaimantId?: string | null;
}

export function LicenseEntitlementPanel({
  canReview,
  canSubmit,
  defaultClaimantId,
}: LicenseEntitlementPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [licenseSubject, setLicenseSubject] = useState("");
  const [claimantId, setClaimantId] = useState(defaultClaimantId ?? "");
  const [entitlement, setEntitlement] = useState<"provider-source-install" | "consumer-use">(
    "consumer-use",
  );
  const [providerOrgId, setProviderOrgId] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const claimsQ = useQuery({
    queryKey: ["ecosystem-license-entitlement-claims"],
    queryFn: listLicenseEntitlementClaims,
    enabled: canReview,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: submitLicenseEntitlementClaim,
    onSuccess: () => {
      toast.success(t("software.license.claimSubmitted"));
      setLicenseSubject("");
      setEvidenceReference("");
      setEvidenceSummary("");
      void client.invalidateQueries({ queryKey: ["ecosystem-license-entitlement-claims"] });
    },
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" | "revoked" }) =>
      decideLicenseEntitlementClaim(
        id,
        decision,
        `Decision recorded in the platform governance workspace: ${decision}`,
      ),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["ecosystem-license-entitlement-claims"] }),
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !licenseSubject.trim() ||
      !claimantId.trim() ||
      !evidenceReference.trim() ||
      !evidenceSummary.trim()
    ) {
      return;
    }
    submit.mutate({
      licenseSubject: licenseSubject.trim(),
      entitlement,
      claimantKind: "org",
      claimantId: claimantId.trim(),
      ...(providerOrgId.trim() ? { providerOrgId: providerOrgId.trim() } : {}),
      evidenceReference: evidenceReference.trim(),
      evidenceSummary: evidenceSummary.trim(),
    });
  }

  if (!canSubmit && !canReview) return null;
  return (
    <section
      className="space-y-3 rounded-md border border-border bg-card p-4"
      data-testid="license-entitlement-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileKey2 className="h-4 w-4" />
            {t("software.license.claimsTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("software.license.claimsDescription")}
          </p>
        </div>
        <Badge variant="outline">{t("software.license.metadataOnly")}</Badge>
      </div>
      {canSubmit ? (
        <form className="grid gap-2 lg:grid-cols-2" onSubmit={submitClaim}>
          <Input
            value={licenseSubject}
            onChange={(event) => setLicenseSubject(event.target.value)}
            placeholder={t("software.license.subjectPlaceholder")}
            aria-label={t("software.license.subject")}
          />
          <select
            aria-label={t("software.license.entitlement")}
            className="flex h-9 w-full rounded-md border border-border bg-card px-3 py-1 text-sm shadow-sm"
            value={entitlement}
            onChange={(event) =>
              setEntitlement(event.target.value as "provider-source-install" | "consumer-use")
            }
          >
            <option value="consumer-use">{t("software.license.consumerUse")}</option>
            <option value="provider-source-install">
              {t("software.license.providerSourceInstall")}
            </option>
          </select>
          <Input
            value={providerOrgId}
            onChange={(event) => setProviderOrgId(event.target.value)}
            placeholder={t("software.license.providerOrgOptional")}
            aria-label={t("software.license.providerOrg")}
          />
          <Input
            value={claimantId}
            onChange={(event) => setClaimantId(event.target.value)}
            placeholder={t("software.license.claimantPlaceholder")}
            aria-label={t("software.license.claimant")}
          />
          <Input
            value={evidenceReference}
            onChange={(event) => setEvidenceReference(event.target.value)}
            placeholder={t("software.license.evidenceReference")}
            aria-label={t("software.license.evidenceReference")}
          />
          <Textarea
            value={evidenceSummary}
            onChange={(event) => setEvidenceSummary(event.target.value)}
            placeholder={t("software.license.evidenceSummary")}
            aria-label={t("software.license.evidenceSummary")}
          />
          <div className="lg:col-span-2 flex justify-end">
            <Button type="submit" size="sm" disabled={submit.isPending}>
              <FileKey2 />
              {t("software.license.submitClaim")}
            </Button>
          </div>
        </form>
      ) : null}
      {canReview ? (
        <ClaimReviewList
          claims={claimsQ.data ?? []}
          loading={claimsQ.isLoading}
          decide={decide.mutate}
        />
      ) : null}
    </section>
  );
}

function ClaimReviewList({
  claims,
  loading,
  decide,
}: {
  claims: LicenseEntitlementClaim[];
  loading: boolean;
  decide: (input: { id: string; decision: "approved" | "rejected" | "revoked" }) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <p className="text-xs text-muted-foreground">{t("common.loading")}</p>;
  if (claims.length === 0)
    return <p className="text-xs text-muted-foreground">{t("software.license.noClaims")}</p>;
  return (
    <div className="grid gap-2">
      {claims.map((claim) => (
        <article
          key={claim.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background p-3"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{claim.licenseSubject}</span>
              <Badge
                variant={
                  claim.status === "approved"
                    ? "succeeded"
                    : claim.status === "pending"
                      ? "outline"
                      : "failed"
                }
              >
                {claim.status}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {claim.entitlement} · {claim.claimantKind}:{claim.claimantId}
            </p>
          </div>
          {claim.status === "pending" ? (
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => decide({ id: claim.id, decision: "approved" })}
              >
                <Check />
                {t("software.license.approve")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => decide({ id: claim.id, decision: "rejected" })}
              >
                <ShieldAlert />
                {t("software.license.reject")}
              </Button>
            </div>
          ) : claim.status === "approved" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => decide({ id: claim.id, decision: "revoked" })}
            >
              <Undo2 />
              {t("software.license.revoke")}
            </Button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function RuntimeAndMaterialPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [providerOrgId, setProviderOrgId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [runtimeProfileId, setRuntimeProfileId] = useState("");
  const [runtimeDigest, setRuntimeDigest] = useState("");
  const [selector, setSelector] = useState("");
  const [materialVersion, setMaterialVersion] = useState("");
  const [elements, setElements] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const bindingsQ = useQuery({
    queryKey: ["runtime-contract-bindings", providerOrgId],
    queryFn: () => listRuntimeContractBindings(providerOrgId),
    enabled: Boolean(providerOrgId),
    retry: false,
  });
  const materialsQ = useQuery({
    queryKey: ["licensed-material-mappings", providerOrgId],
    queryFn: () => listLicensedMaterialMappings(providerOrgId),
    enabled: Boolean(providerOrgId),
    retry: false,
  });
  const bindingsKey = ["runtime-contract-bindings", providerOrgId];
  const materialsKey = ["licensed-material-mappings", providerOrgId];
  const bind = useMutation({
    mutationFn: bindRuntimeContract,
    onSuccess: () => void client.invalidateQueries({ queryKey: bindingsKey }),
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });
  const register = useMutation({
    mutationFn: registerLicensedMaterialMapping,
    onSuccess: () => void client.invalidateQueries({ queryKey: materialsKey }),
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  const baseReady = providerOrgId.trim() !== "" && agentId.trim() !== "";
  return (
    <section
      className="space-y-4 rounded-md border border-border bg-card p-4"
      data-testid="runtime-material-panel"
    >
      <div>
        <h2 className="text-sm font-semibold">{t("software.license.runtimeMaterialTitle")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("software.license.runtimeMaterialDescription")}
        </p>
      </div>
      <Input
        value={providerOrgId}
        onChange={(event) => setProviderOrgId(event.target.value)}
        placeholder={t("software.license.providerOrgPlaceholder")}
        aria-label={t("software.license.providerOrg")}
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <form
          className="grid gap-2 rounded-md border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (baseReady && runtimeProfileId.trim() && runtimeDigest.trim())
              bind.mutate({
                providerOrgId: providerOrgId.trim(),
                agentId: agentId.trim(),
                runtimeContractRef: "python-3.12-stdlib-v1",
                runtimeProfileId: runtimeProfileId.trim(),
                runtimeDigest: runtimeDigest.trim(),
              });
          }}
        >
          <h3 className="text-sm font-medium">{t("software.license.runtimeBinding")}</h3>
          <Input
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            placeholder={t("software.license.agentPlaceholder")}
            aria-label={t("software.license.agent")}
          />
          <Input
            value={runtimeProfileId}
            onChange={(event) => setRuntimeProfileId(event.target.value)}
            placeholder={t("software.license.runtimeProfilePlaceholder")}
            aria-label={t("software.license.runtimeProfile")}
          />
          <Input
            value={runtimeDigest}
            onChange={(event) => setRuntimeDigest(event.target.value)}
            placeholder="sha256:…"
            aria-label={t("software.license.runtimeDigest")}
          />
          <Button type="submit" size="sm" disabled={!baseReady || bind.isPending}>
            {t("software.license.bindRuntime")}
          </Button>
          <GovernanceRows
            rows={(bindingsQ.data ?? []).map(
              (binding) =>
                `${binding.runtimeContractRef} → ${binding.runtimeProfileId} (${binding.agentId ?? binding.clusterId ?? "provider"})`,
            )}
            empty={t("software.license.noRuntimeBindings")}
          />
        </form>
        <form
          className="grid gap-2 rounded-md border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const elementSet = elements
              .split(/[,\s]+/)
              .map((item) => item.trim())
              .filter(Boolean);
            if (
              baseReady &&
              selector.trim() &&
              materialVersion.trim() &&
              fingerprint.trim() &&
              elementSet.length
            )
              register.mutate({
                providerOrgId: providerOrgId.trim(),
                agentId: agentId.trim(),
                selector: selector.trim(),
                materialName: "VASP POTCAR",
                materialVersion: materialVersion.trim(),
                elementSet,
                fingerprint: fingerprint.trim(),
              });
          }}
        >
          <h3 className="text-sm font-medium">{t("software.license.materialMapping")}</h3>
          <Input
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
            placeholder={t("software.license.materialSelector")}
            aria-label={t("software.license.materialSelector")}
          />
          <Input
            value={materialVersion}
            onChange={(event) => setMaterialVersion(event.target.value)}
            placeholder={t("software.license.materialVersion")}
            aria-label={t("software.license.materialVersion")}
          />
          <Input
            value={elements}
            onChange={(event) => setElements(event.target.value)}
            placeholder={t("software.license.elements")}
            aria-label={t("software.license.elements")}
          />
          <Input
            value={fingerprint}
            onChange={(event) => setFingerprint(event.target.value)}
            placeholder={t("software.license.fingerprint")}
            aria-label={t("software.license.fingerprint")}
          />
          <Button type="submit" size="sm" disabled={!baseReady || register.isPending}>
            {t("software.license.registerMaterial")}
          </Button>
          <GovernanceRows
            rows={(materialsQ.data ?? []).map(
              (material) =>
                `${material.selector} · ${material.materialVersion} · ${material.elementSet.join(", ")}`,
            )}
            empty={t("software.license.noMaterialMappings")}
          />
        </form>
      </div>
    </section>
  );
}

function GovernanceRows({ rows, empty }: { rows: string[]; empty: string }) {
  return rows.length === 0 ? (
    <p className="text-xs text-muted-foreground">{empty}</p>
  ) : (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {rows.map((row) => (
        <li key={row} className="break-all">
          {row}
        </li>
      ))}
    </ul>
  );
}
