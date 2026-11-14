import { federationCanonicalJson } from "@kuintessence/shared/federation";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { Textarea } from "../ui/input";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { FederationEmpty } from "./FederationLayout";
import { GovernanceForm } from "./GovernanceForm";
import { GovernanceProgress } from "./GovernanceProgress";
import {
  checkGovernancePayload,
  checkGovernanceRow,
  type GovernanceKind,
  type GovernancePayload,
  type GovernanceRow,
  governanceBase,
  governanceId,
  governanceKinds,
  governanceSchemas,
} from "./governance-policy";

type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  grants: readonly string[];
  readOnly: boolean;
  busy: boolean;
};
type Action =
  | { action: "recover"; row: GovernanceRow; endpoint: string }
  | { action: "approve"; payload: GovernancePayload }
  | { action: "attach"; row: GovernanceRow; signature: string }
  | { action: "revoke"; row: GovernanceRow };
export function CommercialGovernancePanel(props: Props) {
  return (
    <GovernancePanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}`}
      {...props}
    />
  );
}
function GovernancePanel(props: Props) {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(false);
  const [kind, setKind] = useState<GovernanceKind>("arbitration");
  const visibleKind =
    (kind === "grant" || kind === "publication") &&
    !props.grants.includes(governanceSchemas[kind].capability)
      ? "arbitration"
      : kind;
  return (
    <Tabs value={visibleKind} onValueChange={(value) => setKind(value as GovernanceKind)}>
      <TabsList className="federation-subnav" aria-label={t("federation.governance.title")}>
        {governanceKinds
          .filter(
            (k) =>
              (k !== "grant" && k !== "publication") ||
              props.grants.includes(governanceSchemas[k].capability),
          )
          .map((k) => (
            <TabsTrigger key={k} value={k} disabled={locked}>
              {t(`federation.governance.kinds.${k}`)}
            </TabsTrigger>
          ))}
      </TabsList>
      <PolicyPanel key={visibleKind} kind={visibleKind} onLock={setLocked} {...props} />
    </Tabs>
  );
}
function PolicyPanel({
  kind,
  approval,
  scope,
  grants,
  readOnly,
  busy,
  onLock,
}: Props & { kind: GovernanceKind; onLock: (locked: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const base = governanceBase(kind, approval.revisionId);
  const config = governanceSchemas[kind];
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<GovernanceRow | null>(null);
  const [importText, setImportText] = useState("");
  const [signature, setSignature] = useState("");
  const [intent, setIntent] = useState<Action | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [progressRevision, setProgressRevision] = useState(0);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    onLock(!!intent || unknown);
  }, [intent, unknown, onLock]);
  const allowed = useRef(false);
  const active = useRef(true);
  allowed.current =
    !readOnly && !busy && !!approval.counterpartyJws && grants.includes(config.capability);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const assertAllowed = () => {
    if (!active.current || !allowed.current) throw new Error("Policy authority unavailable");
  };
  const check = (raw: unknown) => checkGovernanceRow(kind, raw, approval, scope.organizationId);
  const list = useQuery({
    queryKey: [
      "federation",
      "governance",
      scope.organizationId,
      scope.authRevision,
      approval.revisionId,
      kind,
      page,
    ],
    enabled:
      !!approval.counterpartyJws &&
      ((kind !== "grant" && kind !== "publication") || grants.includes(config.capability)),
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await api.get<{ data: unknown }>(
        `${base}?limit=20&offset=${page * 20}`,
        scope,
      );
      const raw = z
        .object({ data: z.unknown().array().max(20), hasMore: z.boolean() })
        .parse(kind === "publication" ? response : response.data);
      return { ...raw, data: raw.data.map(check) };
    },
  });
  const generate = useMutation({
    retry: false,
    mutationFn: async (input: unknown) => {
      assertAllowed();
      const response = await api.post<{ data: unknown }>(`${base}/draft`, input, scope);
      const payload = checkGovernancePayload(
        config.payload.parse(kind === "publication" ? response : response.data),
        approval,
      );
      assertAllowed();
      setIntent({ action: "approve", payload });
    },
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Action) => {
      assertAllowed();
      let row: GovernanceRow;
      if (action.action === "recover") {
        await api.post(action.endpoint, {}, scope);
        return action.row;
      }
      if (action.action === "approve") {
        const recordId = governanceId(action.payload);
        // Read only this original ID; a failed lookup never proves the write was absent.
        const response = await api.get<{ data: unknown }>(
          `${base}?limit=1&offset=0&${config.filter}=${encodeURIComponent(recordId)}`,
          scope,
        );
        const records = z
          .object({ data: z.unknown().array().max(1), hasMore: z.boolean() })
          .parse(kind === "publication" ? response : response.data)
          .data.map(check);
        assertAllowed();
        if (records[0]) row = records[0];
        else {
          const response = await api.post<{ data: unknown }>(
            `${base}/approve`,
            action.payload,
            scope,
          );
          row = check(kind === "publication" ? response : response.data);
        }
        if (
          governanceId(row.payload) !== recordId ||
          federationCanonicalJson(row.payload) !== federationCanonicalJson(action.payload)
        )
          throw new Error("Policy approval differs from intent");
      } else {
        const response = await api.post<{ data: unknown }>(
          `${base}/${governanceId(action.row.payload)}/${action.action === "attach" ? "counterparty" : "revoke"}`,
          action.action === "attach" ? { approvalJws: action.signature } : {},
          scope,
        );
        row = check(kind === "publication" ? response : response.data);
        if (
          federationCanonicalJson(row.payload) !== federationCanonicalJson(action.row.payload) ||
          (action.action === "revoke" ? !row.revokedAt : row.counterpartyJws !== action.signature)
        )
          throw new Error("Policy action mismatch");
      }
      return row;
    },
    onSuccess: (row) => {
      if (!active.current) return;
      setIntent(null);
      setUnknown(false);
      setProgressRevision((value) => value + 1);
      setSelected(row);
      setEditing(false);
      setSignature("");
      setImportText("");
      void list.refetch();
    },
    onError: () => setUnknown(true),
  });
  const blocked = busy || mutation.isPending || generate.isPending;
  const previewImport = () => {
    try {
      assertAllowed();
      const payload = checkGovernancePayload(
        config.payload.parse(JSON.parse(importText)),
        approval,
      );
      setIntent({ action: "approve", payload });
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  };
  const review = (action: Action) => {
    if (!allowed.current) return;
    mutation.reset();
    setUnknown(false);
    setIntent(action);
  };
  const detail = selected?.payload;
  return (
    <section className="space-y-5" aria-label={t(`federation.governance.kinds.${kind}`)}>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={blocked} onClick={() => void list.refetch()}>
          {t("federation.refresh")}
        </Button>
        {allowed.current ? (
          <Button
            disabled={blocked || !!intent}
            onClick={() => {
              setEditing(!editing);
              setSelected(null);
            }}
          >
            {t(editing ? "federation.cancel" : "federation.governance.create")}
          </Button>
        ) : null}
      </div>
      {!approval.counterpartyJws ? (
        <p role="status">{t("federation.governance.contractRequired")}</p>
      ) : list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : list.data.data.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.data.data.map((row) => (
            <li key={governanceId(row.payload)}>
              <button
                type="button"
                className="flex w-full flex-wrap justify-between gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  setSelected(row);
                  setEditing(false);
                  setSignature("");
                }}
              >
                <span className="min-w-0 break-all">{governanceId(row.payload)}</span>
                <span>
                  {t(
                    row.revokedAt
                      ? "federation.governance.revoked"
                      : row.confirmedAt
                        ? "federation.agreements.bothSigned"
                        : "federation.governance.pending",
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <FederationEmpty>{t("federation.governance.empty")}</FederationEmpty>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={page === 0 || blocked}
          onClick={() => {
            setPage(page - 1);
            setSelected(null);
          }}
        >
          {t("federation.previous")}
        </Button>
        <Button
          variant="outline"
          disabled={!list.data?.hasMore || blocked}
          onClick={() => {
            setPage(page + 1);
            setSelected(null);
          }}
        >
          {t("federation.next")}
        </Button>
      </div>
      {editing && allowed.current ? (
        <>
          <GovernanceForm
            kind={kind}
            disabled={blocked || !!intent}
            onDraft={(input) => generate.mutate(input)}
          />
          <details>
            <summary className="cursor-pointer text-sm">
              {t("federation.governance.import")}
            </summary>
            <label htmlFor={`${id}-import`} className="mt-3 block text-sm">
              {t("federation.governance.terms")}
            </label>
            <Textarea
              id={`${id}-import`}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              disabled={blocked || !!intent}
            />
            <Button
              className="mt-2"
              variant="outline"
              disabled={blocked || !!intent || !importText.trim()}
              onClick={previewImport}
            >
              {t("federation.governance.preview")}
            </Button>
          </details>
        </>
      ) : null}
      {detail && selected ? (
        <div className="space-y-4">
          <PolicyTerms payload={detail} />
          <p className="text-sm">
            {t("federation.governance.createdAt")}:{" "}
            {new Date(selected.createdAt).toLocaleString(i18n.language)}
          </p>
          <label className="grid gap-1 text-sm" htmlFor={`${id}-local-signature`}>
            {t("federation.governance.localSignature")}
            <Textarea
              id={`${id}-local-signature`}
              aria-label={t("federation.governance.localSignature")}
              readOnly
              value={selected.approvalJws}
              className="font-mono text-xs"
            />
          </label>
          {allowed.current && !selected.revokedAt ? (
            <>
              <label className="grid gap-1 text-sm" htmlFor={`${id}-signature`}>
                {t("federation.governance.counterpartySignature")}
                <Textarea
                  id={`${id}-signature`}
                  aria-label={t("federation.governance.counterpartySignature")}
                  value={signature}
                  maxLength={524288}
                  disabled={blocked || !!intent}
                  onChange={(event) => setSignature(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={blocked || !!intent || !signature.trim() || !!selected.counterpartyJws}
                  onClick={() =>
                    review({ action: "attach", row: selected, signature: signature.trim() })
                  }
                >
                  {t("federation.governance.attach")}
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked || !!intent}
                  onClick={() => review({ action: "revoke", row: selected })}
                >
                  {t("federation.governance.revoke")}
                </Button>
              </div>
            </>
          ) : null}
          {allowed.current &&
          kind === "arbitration" &&
          selected.revokedAt &&
          approval.terms.agreement.mode !== "bilateral_direct" ? (
            <Button
              variant="outline"
              disabled={blocked || !!intent}
              onClick={() =>
                review({
                  action: "recover",
                  row: selected,
                  endpoint: `${base}/${governanceId(selected.payload)}/ledger-revocation`,
                })
              }
            >
              {t("federation.governance.recordRevocation")}
            </Button>
          ) : null}
          <GovernanceProgress
            key={`${governanceId(detail)}:${progressRevision}`}
            kind={kind}
            row={selected}
            scope={scope}
            writable={allowed.current}
            busy={blocked || !!intent}
            onRetry={(endpoint) => review({ action: "recover", row: selected, endpoint })}
          />
        </div>
      ) : null}
      {invalid || generate.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.governance.invalid")}
        </p>
      ) : null}
      <Dialog
        open={!!intent}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending && !unknown) setIntent(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (unknown || mutation.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (unknown || mutation.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(`federation.governance.${intent?.action ?? "approve"}`)}</DialogTitle>
            <DialogDescription>
              {t(unknown ? "federation.governance.unknown" : "federation.governance.confirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent ? (
              <PolicyTerms
                payload={intent.action === "approve" ? intent.payload : intent.row.payload}
              />
            ) : null}
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
    </section>
  );
}
export function PolicyTerms({ payload }: { payload: GovernancePayload }) {
  const { t, i18n } = useTranslation();
  const grant = "grant" in payload ? payload.grant : null;
  const identity = "scope" in payload ? payload.scope : (grant ?? payload);
  const recipient =
    "recipientSiteId" in identity
      ? identity.recipientSiteId
      : "arbitratorSiteId" in payload
        ? payload.arbitratorSiteId
        : "scope" in payload
          ? payload.scope.evidenceRecipientSiteId
          : "";
  const selections =
    "disclosures" in payload
      ? payload.disclosures
      : grant
        ? [{ recordType: grant.recordType, fields: grant.fields }]
        : [];
  const validUntil = grant?.validUntil ?? ("validUntil" in payload ? payload.validUntil : "");
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t(
              `federation.governance.fields.${"grant" in payload ? "grantId" : "publicationId" in payload ? "publicationId" : "policyId"}`,
            )}
          </dt>
          <dd className="break-all">{governanceId(payload)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t("federation.governance.fields.recipientSiteId")}
          </dt>
          <dd className="break-all">{recipient}</dd>
        </div>
        {validUntil ? (
          <div>
            <dt className="text-muted-foreground">
              {t("federation.governance.fields.validUntil")}
            </dt>
            <dd>{new Date(validUntil).toLocaleString(i18n.language)}</dd>
          </div>
        ) : null}
        {"maxChargedAmount" in payload ? (
          <div>
            <dt className="text-muted-foreground">
              {t("federation.governance.fields.maxChargedAmount")}
            </dt>
            <dd>
              {payload.maxChargedAmount} · {payload.unit}
            </dd>
          </div>
        ) : null}
      </dl>
      {"actions" in payload ? (
        <p>
          {payload.actions
            .map((action) => t(`federation.governance.outcomes.${action}`))
            .join(" / ")}
        </p>
      ) : null}
      {selections.length ? (
        <ul className="space-y-2">
          {selections.map((selection) => (
            <li key={selection.recordType}>
              <span className="font-medium">
                {t(`federation.governance.records.${selection.recordType}`)}
              </span>
              :{" "}
              {selection.fields
                .map(
                  (field) =>
                    `${t(`federation.governance.disclosureFields.${field}`)}${"requiredEvidence" in payload && payload.requiredEvidence.some((required) => required.recordType === selection.recordType && required.fields.some((item) => item === field)) ? ` (${t("federation.governance.required")})` : ""}`,
                )
                .join(", ")}
            </li>
          ))}
        </ul>
      ) : null}
      <details className="min-w-0">
        <summary className="cursor-pointer text-sm font-medium">
          {t("federation.governance.terms")}
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}
