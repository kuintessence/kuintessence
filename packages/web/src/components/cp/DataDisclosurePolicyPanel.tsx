import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface Policy {
  id: string;
  status: string;
  updatedAt: string;
  expiresAt: string | null;
  reason: string | null;
  subjectKind: string;
  effect: string;
  downloadPolicy: string;
  redistributionPolicy: string;
  crossCenterReplicationPolicy: string;
}
interface PolicyView {
  policy: Policy | null;
  editable: boolean;
  canApprove: boolean;
  otherPolicies: Policy[];
  hasMorePolicies: boolean;
}

export function DataDisclosurePolicyPanel({
  organizationId,
  versionId,
}: {
  organizationId: string;
  versionId: string;
}) {
  const revision = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().revision,
    () => null,
  );
  return (
    <PolicyEditor
      key={`${organizationId}:${versionId}:${revision}`}
      scope={{ organizationId, authRevision: revision }}
      versionId={versionId}
    />
  );
}

function PolicyEditor({ scope, versionId }: { scope: ApiOrganizationScope; versionId: string }) {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const path = `/cp/data/versions/${versionId}/disclosure-policy`;
  const readOnly = useMobileMutationBlocked(path);
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [draftRevision, setDraftRevision] = useState<string | null | undefined>();
  const query = useQuery({
    queryKey: ["cp-data", scope.organizationId, "disclosure-policy", versionId, scope.authRevision],
    queryFn: async () => (await api.get<{ data: PolicyView }>(path, scope)).data,
    retry: false,
  });
  const policy = query.data?.policy;
  const beginEdit = () =>
    setDraftRevision((previous) =>
      previous === undefined ? (policy?.updatedAt ?? null) : previous,
    );
  const enabled =
    policy?.status === "active" && (!policy.expiresAt || Date.parse(policy.expiresAt) > Date.now());
  const mutation = useMutation({
    mutationFn: async (allow: boolean) => {
      if (readOnly || needsRefresh || query.isError || !query.data?.editable)
        throw new Error("Policy unavailable");
      const expiresAt = allow
        ? new Date(expiry).toISOString()
        : (policy?.expiresAt ?? new Date().toISOString());
      if (!expiresAt) throw new Error("Expiry required");
      return api.post(
        path,
        {
          enabled: allow,
          expiresAt,
          reason: reason.trim(),
          expectedUpdatedAt:
            draftRevision === undefined ? (policy?.updatedAt ?? null) : draftRevision,
        },
        scope,
      );
    },
    onSuccess: async () => {
      setReason("");
      setExpiry("");
      setDraftRevision(undefined);
      const result = await query.refetch();
      setNeedsRefresh(result.isError);
    },
    onError: () => setNeedsRefresh(true),
  });
  const refresh = async () => {
    const result = await query.refetch();
    if (!result.isError) {
      setReason("");
      setExpiry("");
      setDraftRevision(undefined);
      setNeedsRefresh(false);
      mutation.reset();
    }
  };
  const disabled =
    readOnly || needsRefresh || query.isFetching || mutation.isPending || !reason.trim();
  const rules =
    query.data?.otherPolicies.filter(
      (p) => p.status === "active" && (!p.expiresAt || Date.parse(p.expiresAt) > Date.now()),
    ) ?? [];
  return (
    <section className="space-y-3 border-t pt-4" aria-label={t("cp.data.disclosure.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("cp.data.disclosure.title")}</h3>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => void refresh()}
          disabled={query.isFetching || mutation.isPending}
        >
          {t("common.refresh")}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm">
          {t("common.loading")}
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("cp.data.disclosure.loadFailed")}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("cp.data.disclosure.scope")}</dt>
            <dd>{t("cp.data.disclosure.scopeValue")}</dd>
            <dt className="text-muted-foreground">{t("cp.data.disclosure.status")}</dt>
            <dd>{t(enabled ? "cp.data.disclosure.allowed" : "cp.data.disclosure.notAllowed")}</dd>
            {policy?.expiresAt ? (
              <>
                <dt className="text-muted-foreground">{t("cp.data.disclosure.expiry")}</dt>
                <dd className="tabular-nums">
                  {new Date(policy.expiresAt).toLocaleString(i18n.language)}
                </dd>
              </>
            ) : null}
          </dl>
          {rules.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer">
                {t("cp.data.disclosure.otherRules", { count: rules.length })}
              </summary>
              <ul className="mt-2 space-y-2">
                {rules.map((rule) => (
                  <li key={rule.id} className="break-words">
                    {t(`cp.data.disclosure.subject.${rule.subjectKind}`)} ·{" "}
                    {t(
                      rule.effect === "allow" &&
                        rule.downloadPolicy === "allow" &&
                        rule.redistributionPolicy === "allow" &&
                        rule.crossCenterReplicationPolicy === "allow"
                        ? "cp.data.disclosure.allowed"
                        : "cp.data.disclosure.restricted",
                    )}
                    {rule.reason ? ` · ${rule.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {query.data?.hasMorePolicies ? (
            <p className="text-sm">{t("cp.data.disclosure.moreRules")}</p>
          ) : null}
          {!query.data?.editable ? (
            <p role="alert" className="text-sm">
              {t("cp.data.disclosure.scopeConflict")}
            </p>
          ) : readOnly ? (
            <p className="text-sm text-muted-foreground">{t("cp.data.disclosure.desktopOnly")}</p>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate(true);
              }}
            >
              <p className="text-sm text-muted-foreground">{t("cp.data.disclosure.permission")}</p>
              {!query.data?.canApprove ? (
                <p role="status" className="text-sm">
                  {t("cp.data.disclosure.versionUnavailable")}
                </p>
              ) : null}
              <label className="block space-y-1 text-sm" htmlFor={`${formId}-expiry`}>
                <span>{t("cp.data.disclosure.expiry")}</span>
                <Input
                  id={`${formId}-expiry`}
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => {
                    beginEdit();
                    setExpiry(e.target.value);
                  }}
                  required
                  disabled={needsRefresh || mutation.isPending}
                />
              </label>
              <label className="block space-y-1 text-sm" htmlFor={`${formId}-reason`}>
                <span>{t("cp.data.disclosure.reason")}</span>
                <Input
                  id={`${formId}-reason`}
                  value={reason}
                  onChange={(e) => {
                    beginEdit();
                    setReason(e.target.value);
                  }}
                  maxLength={500}
                  required
                  disabled={needsRefresh || mutation.isPending}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={
                    disabled ||
                    !query.data?.canApprove ||
                    !expiry ||
                    !Number.isFinite(Date.parse(expiry)) ||
                    Date.parse(expiry) <= Date.now()
                  }
                >
                  {t(enabled ? "cp.data.disclosure.renew" : "cp.data.disclosure.allow")}
                </Button>
                {enabled ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => mutation.mutate(false)}
                  >
                    {t("cp.data.disclosure.revoke")}
                  </Button>
                ) : null}
              </div>
            </form>
          )}
          {mutation.isError || needsRefresh ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("cp.data.disclosure.saveFailed")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
