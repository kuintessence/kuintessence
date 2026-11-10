import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileKey2, ShieldAlert, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { isMobileHighRiskMutationBlocked } from "../../lib/mobile-management-policy";
import {
  listSandboxAgentSecurityViews,
  listSandboxRuntimeProfiles,
} from "../../lib/sandbox-client";
import {
  bindRuntimeContract,
  decideLicenseEntitlementClaim,
  type LicenseEntitlementClaim,
  listLicensedMaterialMappings,
  listLicenseEntitlementClaims,
  listRuntimeContractBindings,
  listSpackCatalog,
  registerLicensedMaterialMapping,
  submitLicenseEntitlementClaim,
} from "../../lib/software-client";
import { useMediaQuery } from "../../lib/use-media-query";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { PaginationControls } from "../ui/pagination-controls";

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
          <NativeSelect
            aria-label={t("software.license.entitlement")}
            className="flex w-full"
            value={entitlement}
            onChange={(event) =>
              setEntitlement(event.target.value as "provider-source-install" | "consumer-use")
            }
          >
            <option value="consumer-use">{t("software.license.consumerUse")}</option>
            <option value="provider-source-install">
              {t("software.license.providerSourceInstall")}
            </option>
          </NativeSelect>
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

export function RuntimeAndMaterialPanel({ canManage = false }: { canManage?: boolean }) {
  const { t } = useTranslation();
  const providerOrgId = useActiveOrganizationId();
  const compact = useMediaQuery("(max-width: 767px)");
  const compactReadOnly =
    compact && isMobileHighRiskMutationBlocked("/software/runtime-contract-bindings");
  const writable = canManage && !compactReadOnly;
  if (!providerOrgId)
    return (
      <p className="text-sm text-muted-foreground">{t("software.license.selectOrganization")}</p>
    );
  return (
    <RuntimeAndMaterialEditor
      key={`${providerOrgId}:${writable}:${compactReadOnly}`}
      providerOrgId={providerOrgId}
      canManage={writable}
      compactReadOnly={compactReadOnly}
    />
  );
}

function RuntimeAndMaterialEditor({
  providerOrgId,
  canManage,
  compactReadOnly,
}: {
  providerOrgId: string;
  canManage: boolean;
  compactReadOnly: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const [runtimeProfileId, setRuntimeProfileId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [assetPage, setAssetPage] = useState(1);
  const [selector, setSelector] = useState("");
  const [materialVersion, setMaterialVersion] = useState("");
  const [elements, setElements] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const agentsQ = useQuery({
    queryKey: ["runtime-binding-agents", providerOrgId],
    queryFn: listSandboxAgentSecurityViews,
  });
  const profilesQ = useQuery({
    queryKey: ["runtime-binding-profiles", providerOrgId],
    queryFn: listSandboxRuntimeProfiles,
  });
  const agents = (agentsQ.data ?? []).filter((agent) => agent.providerOrgId === providerOrgId);
  const agent = agents.find((item) => item.agentId === agentId);
  const profiles = (profilesQ.data ?? []).filter(
    (profile) =>
      profile.lifecycle === "active" &&
      profile.language === "python" &&
      /^3\.12(?:\.|$)/.test(profile.languageVersion) &&
      profile.adapters.some((adapter) => adapter === agent?.schedulerType) &&
      (agent?.schedulerType === "kubernetes" ? profile.ociDigest : profile.sifDigest),
  );
  const profile = profiles.find((item) => item.id === runtimeProfileId);
  const runtimeDigest =
    agent?.schedulerType === "kubernetes" ? profile?.ociDigest : profile?.sifDigest;
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
  const assetsQ = useQuery({
    queryKey: ["licensed-material-software", providerOrgId, assetPage],
    queryFn: () => listSpackCatalog("vasp", 100, "official", assetPage),
    enabled: !compactReadOnly,
    retry: false,
  });
  const assets = (assetsQ.data?.packages ?? []).filter(
    (item) => item.asset && item.licensePolicy?.identifiers.length,
  );
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

  const queries = [agentsQ, profilesQ, bindingsQ, materialsQ];
  const failed = queries.filter((query) => query.error);
  const baseReady =
    canManage && !!agent && !failed.length && queries.every((query) => !query.isPending);
  const elementSet = [...new Set(elements.split(/[,\s]+/).filter(Boolean))];
  const materialReady =
    baseReady &&
    !assetsQ.isPending &&
    !assetsQ.error &&
    assets.some((item) => item.asset?.id === assetId) &&
    !!selector.trim() &&
    !!materialVersion.trim() &&
    !!fingerprint.trim() &&
    elementSet.length > 0;
  const runtimeRows = (bindingsQ.data ?? [])
    .filter((binding) => !agentId || !binding.agentId || binding.agentId === agentId)
    .map(
      (binding) =>
        `${binding.runtimeContractRef} → ${profilesQ.data?.find((item) => item.id === binding.runtimeProfileId)?.name ?? binding.runtimeProfileId} (${agents.find((item) => item.agentId === binding.agentId)?.siteName ?? binding.agentId ?? binding.clusterId ?? "provider"})`,
    );
  const materialRows = (materialsQ.data ?? [])
    .filter((material) => !agentId || !material.agentId || material.agentId === agentId)
    .map(
      (material) =>
        `${material.selector} · ${material.materialVersion} · ${material.elementSet.join(", ")}`,
    );
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
      {!canManage && (
        <p className="text-sm text-muted-foreground">{t("software.license.readOnly")}</p>
      )}
      {failed.length ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{t("software.license.loadFailed")}</p>
          <Button
            variant="outline"
            onClick={() => void Promise.all(failed.map((query) => query.refetch()))}
          >
            {t("cp.common.retry")}
          </Button>
        </div>
      ) : queries.some((query) => query.isPending) ? (
        <p role="status">{t("cp.common.loading")}</p>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            {t("cp.accounts.registration.agent")}
            <NativeSelect
              aria-label={t("cp.accounts.registration.agent")}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setRuntimeProfileId("");
                setAssetId("");
                setSelector("");
                setMaterialVersion("");
                setElements("");
                setFingerprint("");
              }}
              className="w-full"
            >
              <option value="">{t("cp.accounts.registration.selectAgent")}</option>
              {agents.map((item) => (
                <option key={item.agentId} value={item.agentId}>
                  {item.siteName} · {item.agentId} ({item.schedulerType})
                </option>
              ))}
            </NativeSelect>
          </label>
          {!agents.length && (
            <p className="text-sm text-muted-foreground">
              {t("cp.accounts.registration.noAgents")}
            </p>
          )}
          {compactReadOnly ? (
            <div className="space-y-4" data-testid="runtime-material-readonly-summary">
              <section aria-label={t("software.license.runtimeBinding")} className="space-y-2">
                <h3 className="text-sm font-medium">{t("software.license.runtimeBinding")}</h3>
                <GovernanceRows
                  rows={runtimeRows}
                  empty={t("software.license.noRuntimeBindings")}
                />
              </section>
              <section aria-label={t("software.license.materialMapping")} className="space-y-2">
                <h3 className="text-sm font-medium">{t("software.license.materialMapping")}</h3>
                <GovernanceRows
                  rows={materialRows}
                  empty={t("software.license.noMaterialMappings")}
                />
              </section>
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              <form
                className="grid gap-2 rounded-md border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (baseReady && profile && runtimeDigest)
                    bind.mutate({
                      providerOrgId: providerOrgId.trim(),
                      agentId: agentId.trim(),
                      runtimeContractRef: "python-3.12-stdlib-v1",
                      runtimeProfileId: profile.id,
                      runtimeDigest,
                    });
                }}
              >
                <h3 className="text-sm font-medium">{t("software.license.runtimeBinding")}</h3>
                <p className="text-xs text-muted-foreground">Python 3.12 · python-3.12-stdlib-v1</p>
                <label className="grid gap-1 text-sm">
                  {t("software.license.runtimeProfile")}
                  <NativeSelect
                    aria-label={t("software.license.runtimeProfile")}
                    value={runtimeProfileId}
                    disabled={!baseReady || bind.isPending}
                    onChange={(event) => setRuntimeProfileId(event.target.value)}
                    className="w-full min-w-0"
                  >
                    <option value="">{t("software.license.selectRuntime")}</option>
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.languageVersion}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                {agent && !profiles.length && (
                  <p className="text-sm text-muted-foreground">
                    {t("software.license.noCompatibleRuntime")}
                  </p>
                )}
                {runtimeDigest && (
                  <p
                    className="break-all font-mono text-xs text-muted-foreground"
                    title={t("software.license.runtimeDigest")}
                  >
                    {runtimeDigest}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={!baseReady || !runtimeDigest || bind.isPending}
                >
                  {t("software.license.bindRuntime")}
                </Button>
                <GovernanceRows
                  rows={runtimeRows}
                  empty={t("software.license.noRuntimeBindings")}
                />
              </form>
              <form
                className="grid gap-2 rounded-md border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (materialReady)
                    register.mutate({
                      providerOrgId: providerOrgId.trim(),
                      agentId: agentId.trim(),
                      assetId,
                      selector: selector.trim(),
                      materialName: "VASP POTCAR",
                      materialVersion: materialVersion.trim(),
                      elementSet,
                      fingerprint: fingerprint.trim(),
                    });
                }}
              >
                <h3 className="text-sm font-medium">{t("software.license.materialMapping")}</h3>
                <fieldset disabled={!baseReady || register.isPending} className="grid gap-2">
                  <label className="grid gap-1 text-sm">
                    {t("software.license.materialSoftware")}
                    <NativeSelect
                      aria-label={t("software.license.materialSoftware")}
                      value={assetId}
                      onChange={(event) => setAssetId(event.target.value)}
                      disabled={assetsQ.isPending || !!assetsQ.error}
                      className="w-full min-w-0"
                    >
                      <option value="">{t("software.license.selectMaterialSoftware")}</option>
                      {assets.map((item) => (
                        <option key={item.asset?.id} value={item.asset?.id}>
                          {item.name} · {item.asset?.version}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  {assetsQ.error ? (
                    <div role="alert" className="flex items-center gap-2 text-sm">
                      <span>{t("software.license.loadFailed")}</span>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void assetsQ.refetch()}
                      >
                        {t("cp.common.retry")}
                      </Button>
                    </div>
                  ) : assetsQ.isPending ? (
                    <p role="status">{t("cp.common.loading")}</p>
                  ) : !assets.length ? (
                    <p className="text-sm text-muted-foreground">
                      {t("software.license.noMaterialSoftware")}
                    </p>
                  ) : null}
                  {assetPage > 1 || assetsQ.data?.hasNext ? (
                    <PaginationControls
                      previous={{
                        disabled: assetPage === 1 || assetsQ.isPending,
                        onClick: () => {
                          setAssetId("");
                          setAssetPage(assetPage - 1);
                        },
                      }}
                      next={{
                        disabled: !assetsQ.data?.hasNext || assetsQ.isPending,
                        onClick: () => {
                          setAssetId("");
                          setAssetPage(assetPage + 1);
                        },
                      }}
                    />
                  ) : null}
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
                  <Button type="submit" size="sm" disabled={!materialReady || register.isPending}>
                    {t("software.license.registerMaterial")}
                  </Button>
                </fieldset>
                <GovernanceRows
                  rows={materialRows}
                  empty={t("software.license.noMaterialMappings")}
                />
              </form>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GovernanceRows({ rows, empty }: { rows: string[]; empty: string }) {
  return rows.length === 0 ? (
    <p className="text-xs text-muted-foreground">{empty}</p>
  ) : (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {rows.map((row) => (
        <li key={row} className="break-words [overflow-wrap:anywhere]">
          {row}
        </li>
      ))}
    </ul>
  );
}
