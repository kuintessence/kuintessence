import { federationCanonicalJson } from "@kuintessence/shared/federation";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import { CommercialDisclosureReadScopeSchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ArbitrationDecisionPanel } from "./ArbitrationDecisionPanel";
import { checkEvidenceScope, type EvidenceCase, EvidenceCaseSchema } from "./evidence-case-view";
import { FederationRefreshNotice } from "./FederationLayout";

const MaterialsSchema = z.object({
  data: z
    .object({ scope: CommercialDisclosureReadScopeSchema, receivedAt: z.iso.datetime() })
    .array()
    .max(20),
  hasMore: z.boolean(),
});
export function EvidenceCaseDetail({
  row,
  scope,
  grants,
  readOnly,
  busy,
  onClosed,
}: {
  row: EvidenceCase;
  scope: ApiOrganizationScope;
  grants: readonly string[];
  readOnly: boolean;
  busy: boolean;
  onClosed: (row: EvidenceCase) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const base = `/federation/evidence-cases/${row.caseId}`;
  const [page, setPage] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [intent, setIntent] = useState<
    z.infer<typeof CommercialDisclosureReadScopeSchema> | "close" | null
  >(null);
  const [unknown, setUnknown] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [evidence, setEvidence] = useState<{
    payload: z.infer<typeof CommercialDisclosureSchema>;
    checkedAt: string;
  } | null>(null);
  const [grantIds, setGrantIds] = useState<string[]>([]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const allowed = useRef(false);
  allowed.current = !readOnly && !busy && !row.closedAt && grants.includes("disclosure.receive");
  const materials = useQuery({
    queryKey: [
      "federation",
      "evidence-materials",
      scope.organizationId,
      scope.authRevision,
      row.caseId,
      page,
    ],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const data = MaterialsSchema.parse(
        await api.get(`${base}/disclosures?limit=20&offset=${page * 20}`, scope),
      );
      for (const item of data.data) checkEvidenceScope(item.scope, row);
      return data;
    },
  });
  const read = useMutation({
    retry: false,
    onMutate: () => setEvidence(null),
    mutationFn: async (readScope: z.infer<typeof CommercialDisclosureReadScopeSchema>) => {
      checkEvidenceScope(readScope, row);
      const payload = CommercialDisclosureSchema.parse(
        (await api.get<{ disclosure: unknown }>(`${base}/disclosures/${readScope.grantId}`, scope))
          .disclosure,
      );
      const grant = payload.grant;
      if (
        grant.grantId !== readScope.grantId ||
        grant.caseId !== row.caseId ||
        grant.policyId !== readScope.policyId ||
        grant.policyDigest !== readScope.policyDigest ||
        grant.recipientSiteId !== row.localSiteId ||
        grant.agreementRevisionId !== row.context.agreementRevisionId ||
        grant.domainId !== row.context.domainId ||
        grant.sourceSiteId !== row.context.sourceSiteId ||
        grant.targetSiteId !== row.context.targetSiteId
      )
        throw new Error("Disclosure scope mismatch");
      return { payload, checkedAt: new Date().toISOString() };
    },
    onSuccess: (result) => {
      if (active.current) setEvidence(result);
    },
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: NonNullable<typeof intent>) => {
      if (!active.current || !allowed.current) throw new Error("Evidence operation unavailable");
      if (action === "close") {
        const result = EvidenceCaseSchema.parse(await api.post(`${base}/close`, {}, scope));
        if (
          result.localOrgId !== scope.organizationId ||
          !result.closedAt ||
          federationCanonicalJson(result.context) !== federationCanonicalJson(row.context)
        )
          throw new Error("Case closure mismatch");
        return result;
      }
      checkEvidenceScope(action, row);
      const payload = CommercialDisclosureSchema.parse(
        (await api.post<{ disclosure: unknown }>(`${base}/disclosures`, action, scope)).disclosure,
      );
      if (
        payload.grant.grantId !== action.grantId ||
        payload.grant.caseId !== row.caseId ||
        payload.grant.policyId !== action.policyId ||
        payload.grant.policyDigest !== action.policyDigest ||
        payload.grant.recipientSiteId !== row.localSiteId
      )
        throw new Error("Imported disclosure mismatch");
      return null;
    },
    onSuccess: (result) => {
      if (!active.current) return;
      setIntent(null);
      setUnknown(false);
      setEvidence(null);
      setFields({});
      if (result) onClosed(result);
      else void materials.refetch();
    },
    onError: () => setUnknown(true),
  });
  const refreshing = busy || mutation.isPending || read.isPending || materials.isFetching;
  const blocked = refreshing || materials.isError;
  allowed.current = allowed.current && !materials.isError && !materials.isFetching;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 break-all font-medium">{row.caseId}</h3>
        <span>{t(row.closedAt ? "federation.evidence.closed" : "federation.evidence.open")}</span>
        {allowed.current ? (
          <Button
            variant="outline"
            disabled={blocked || !!intent}
            onClick={() => {
              mutation.reset();
              setIntent("close");
            }}
          >
            {t("federation.evidence.close")}
          </Button>
        ) : null}
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {Object.entries(row.context)
          .filter(([key]) => key !== "caseId")
          .map(([key, value]) => (
            <div className="min-w-0" key={key}>
              <dt className="text-muted-foreground">{t(`federation.evidence.fields.${key}`)}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
      </dl>
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{t("federation.evidence.materials")}</h3>
          <Button
            variant="outline"
            disabled={refreshing}
            onClick={() => {
              void materials.refetch();
            }}
          >
            {t("federation.refresh")}
          </Button>
        </div>
        {allowed.current ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const scope = CommercialDisclosureReadScopeSchema.parse({
                  ...row.context,
                  ...fields,
                });
                setIntent(scope);
                setInvalid(false);
                mutation.reset();
              } catch {
                setInvalid(true);
              }
            }}
          >
            <fieldset disabled={blocked || !!intent} className="grid gap-3 sm:grid-cols-2">
              {["grantId", "disclosureDigest", "policyId", "policyDigest"].map((key) => (
                <label className="grid gap-1 text-sm" htmlFor={`${id}-${key}`} key={key}>
                  {t(`federation.governance.fields.${key}`)}
                  <Input
                    required
                    id={`${id}-${key}`}
                    value={fields[key] ?? ""}
                    onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
                  />
                </label>
              ))}
            </fieldset>
            <Button type="submit" disabled={blocked || !!intent}>
              {t("federation.evidence.import")}
            </Button>
          </form>
        ) : null}
        {invalid ? <p role="alert">{t("federation.governance.invalid")}</p> : null}
        <FederationRefreshNotice query={materials} onRetry={() => void materials.refetch()} />
        {federationReadFailed(materials) ? (
          <p role="alert">{t("federation.loadFailed")}</p>
        ) : materials.isPending || !materials.data ? (
          <p role="status">{t("federation.loading")}</p>
        ) : (
          <>
            <ul className="divide-y divide-border rounded-md border border-border">
              {materials.data.data.map((item) => (
                <li key={item.scope.grantId} className="flex flex-wrap items-center gap-3 p-3">
                  <label className="flex w-full min-w-0 items-center gap-2 text-sm sm:w-auto sm:flex-1">
                    <input
                      type="checkbox"
                      className="shrink-0"
                      disabled={blocked || !!row.closedAt}
                      checked={grantIds.includes(item.scope.grantId)}
                      onChange={() =>
                        setGrantIds(
                          grantIds.includes(item.scope.grantId)
                            ? grantIds.filter((value) => value !== item.scope.grantId)
                            : [...grantIds, item.scope.grantId],
                        )
                      }
                    />
                    <span className="break-all">{item.scope.grantId}</span>
                  </label>
                  <time className="text-sm" dateTime={item.receivedAt}>
                    {new Date(item.receivedAt).toLocaleString(i18n.language)}
                  </time>
                  <Button
                    variant="outline"
                    disabled={blocked || !!row.closedAt}
                    onClick={() => read.mutate(item.scope)}
                  >
                    {t("federation.evidence.read")}
                  </Button>
                </li>
              ))}
            </ul>
            {!materials.data.data.length ? <p>{t("federation.evidence.noMaterials")}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!page || blocked}
                onClick={() => {
                  setPage(page - 1);
                  setEvidence(null);
                }}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={!materials.data.hasMore || blocked}
                onClick={() => {
                  setPage(page + 1);
                  setEvidence(null);
                }}
              >
                {t("federation.next")}
              </Button>
            </div>
          </>
        )}
        {read.isError ? <p role="alert">{t("federation.evidence.readFailed")}</p> : null}
        {evidence && !federationReadFailed(materials) ? (
          <div className="space-y-2">
            <p className="text-sm">
              {t("federation.evidence.checkedAt")}:{" "}
              {new Date(evidence.checkedAt).toLocaleString(i18n.language)}
            </p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(evidence.payload.evidence, null, 2)}
            </pre>
          </div>
        ) : null}
      </section>
      {grants.includes("arbitration.read") && !federationReadFailed(materials) ? (
        <ArbitrationDecisionPanel
          row={row}
          scope={scope}
          grants={grants}
          grantIds={grantIds}
          readOnly={readOnly}
          busy={blocked || !!intent}
        />
      ) : null}
      <Dialog
        open={!!intent && !federationReadFailed(materials)}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending && !unknown) setIntent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(intent === "close" ? "federation.evidence.close" : "federation.evidence.import")}
            </DialogTitle>
            <DialogDescription>
              {t(
                unknown
                  ? "federation.governance.unknown"
                  : intent === "close"
                    ? "federation.evidence.closeConfirm"
                    : "federation.evidence.importConfirm",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="break-all text-sm">{intent === "close" ? row.caseId : intent?.grantId}</p>
            {mutation.isError ? <p role="alert">{t("federation.saveFailed")}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending || unknown}
              onClick={() => setIntent(null)}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={blocked || !allowed.current}
              onClick={() => {
                if (intent) mutation.mutate(intent);
              }}
            >
              {t(unknown ? "federation.governance.recover" : "federation.governance.approve")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
