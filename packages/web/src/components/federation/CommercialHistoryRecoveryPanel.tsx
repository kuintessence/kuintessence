import {
  type FederationCapability,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import {
  type CommercialHistoryRecovery,
  CommercialHistoryRecoveryFileSchema,
  CommercialHistoryRecoverySchema,
  CommercialHistoryRecoveryViewSchema,
} from "@kuintessence/shared/federation/history-recovery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { Input, Textarea } from "../ui/input";
import { AgreementFact } from "./AgreementTerms";

const prefix = "federation.historyRecovery";
type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  submissionId: string;
  grants: readonly FederationCapability[];
  readOnly: boolean;
  busy: boolean;
  onClose: () => void;
};

export function CommercialHistoryRecoveryPanel(props: Props) {
  return (
    <HistoryRecovery
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.submissionId}`}
      {...props}
    />
  );
}

function HistoryRecovery({
  approval,
  scope,
  submissionId,
  grants,
  readOnly,
  busy,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const key = ["federation", "commercial", scope.organizationId, scope.authRevision];
  const path = `/federation/commercial-agreements/${approval.revisionId}/submissions/${submissionId}/history-recovery`;
  const writable = !readOnly && grants.includes("attestation.recover");
  const allowed = useRef(false);
  allowed.current = writable && !busy;
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<CommercialHistoryRecovery | null>(null);
  const [peerJws, setPeerJws] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reauthorizing, setReauthorizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const check = (payload: CommercialHistoryRecovery) => {
    if (
      payload.domainId !== approval.terms.domainId ||
      payload.agreementRevisionId !== approval.revisionId ||
      payload.sourceSiteId !== approval.terms.agreement.sourceSiteId ||
      payload.targetSiteId !== approval.terms.agreement.targetSiteId ||
      approval.terms.agreement.mode !== "bilateral_attested"
    )
      throw new Error("History recovery scope mismatch");
    return payload;
  };
  const parseView = (input: unknown) => {
    const value = CommercialHistoryRecoveryViewSchema.parse(input);
    check(value.payload);
    if (
      value.original.id !== submissionId ||
      value.original.recordId !== value.payload.originalRecordId ||
      value.original.operation !== value.payload.originalOperation ||
      value.original.digest !== value.payload.originalDigest
    )
      throw new Error("History recovery original mismatch");
    return value;
  };
  const history = useQuery({
    queryKey: [...key, "history-recovery", approval.revisionId, submissionId],
    queryFn: async () => {
      const { data } = await api.get<{ data: unknown }>(path, scope);
      return data === null ? null : parseView(data);
    },
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      confirming || reauthorizing || draft
        ? false
        : query.state.data?.ledger?.state === "pending"
          ? 10000
          : false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!allowed.current || history.isError || history.data)
        throw new Error("History recovery unavailable");
      return check(
        CommercialHistoryRecoverySchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${path}/draft`,
              { recoveryId: crypto.randomUUID(), reason },
              scope,
            )
          ).data,
        ),
      );
    },
    onSuccess: (value) => {
      if (allowed.current && active.current) {
        setDraft(value);
        setPeerJws(null);
        setMessage(null);
      }
    },
  });
  const approve = useMutation({
    mutationFn: async () => {
      if (!allowed.current || !draft || history.isError)
        throw new Error("History recovery approval unavailable");
      const value = parseView((await api.post<{ data: unknown }>(path, check(draft), scope)).data);
      if (federationCanonicalJson(value.payload) !== federationCanonicalJson(draft))
        throw new Error("History recovery approval mismatch");
      if (peerJws) {
        if (!allowed.current || !active.current)
          throw new Error("History recovery authority changed");
        await api.post(`${path}/counterparty`, { jws: peerJws }, scope);
      }
    },
    onSuccess: async () => {
      setConfirming(false);
      setDraft(null);
      setPeerJws(null);
      await client.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      void history.refetch();
    },
  });
  const reauthorize = useMutation({
    mutationFn: async () => {
      if (!allowed.current || history.isError || !history.data?.canReauthorize)
        throw new Error("History recovery reauthorization unavailable");
      const value = parseView(
        (await api.post<{ data: unknown }>(`${path}/reauthorize`, {}, scope)).data,
      );
      if (federationCanonicalJson(value.payload) !== federationCanonicalJson(history.data.payload))
        throw new Error("Reauthorized recovery changed the original");
    },
    onSuccess: async () => {
      setReauthorizing(false);
      setPeerJws(null);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  useEffect(() => {
    if (!writable) {
      setConfirming(false);
      setReauthorizing(false);
      setDraft(null);
      setPeerJws(null);
    }
  }, [writable]);
  const error = (cause: unknown) =>
    cause instanceof ApiError
      ? t(`${prefix}.errors.${cause.code}`, { defaultValue: t(`${prefix}.failed`) })
      : t(`${prefix}.failed`);
  const value = history.data?.payload ?? draft;
  const exportApproval = () => {
    if (!history.data) return;
    try {
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                payload: history.data.payload,
                jws: history.data.approvalJws,
                originalInput: history.data.originalInput,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `history-recovery-${history.data.payload.recoveryId}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setMessage(t("federation.commercial.exportFailed"));
    }
  };
  const attach = useMutation({
    mutationFn: async (jws: string) => {
      if (!allowed.current || !history.data || history.isError)
        throw new Error("Counterpart approval unavailable");
      await api.post(`${path}/counterparty`, { jws }, scope);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const retry = useMutation({
    mutationFn: async () => {
      if (!allowed.current || history.isError || history.data?.ledger?.state !== "needs_review")
        throw new Error("History recovery retry unavailable");
      await api.post(
        `/federation/commercial-agreements/${approval.revisionId}/submissions/${history.data.ledger.id}/retry`,
        {},
        scope,
      );
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const actionPending =
    generate.isPending ||
    approve.isPending ||
    reauthorize.isPending ||
    attach.isPending ||
    retry.isPending;
  pending.current = actionPending;
  const blocked = busy || history.isFetching || history.isError || actionPending;
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{t(`${prefix}.title`)}</h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={blocked || attach.isPending}
            onClick={() => void history.refetch()}
          >
            {t("federation.refresh")}
          </Button>
          <Button variant="ghost" disabled={actionPending} onClick={onClose}>
            {t("federation.cancel")}
          </Button>
        </div>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">{t(`${prefix}.effect`)}</p>
      <p className="break-all text-xs text-muted-foreground">{submissionId}</p>
      {history.isError ? (
        <p role="alert">{error(history.error)}</p>
      ) : history.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {value ? (
            <>
              <p className="break-words text-sm">{value.reason}</p>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <AgreementFact label={t(`${prefix}.operation`)}>
                  {value.originalOperation}
                </AgreementFact>
                <AgreementFact label={t(`${prefix}.record`)}>
                  {value.originalRecordId}
                </AgreementFact>
                <AgreementFact label={t(`${prefix}.digest`)}>{value.originalDigest}</AgreementFact>
                <AgreementFact label={t(`${prefix}.inputDigest`)}>
                  {value.originalInputDigest}
                </AgreementFact>
              </dl>
            </>
          ) : null}
          {history.data ? (
            <>
              <p role="status" className="text-sm">
                {t(
                  `${prefix}.${history.data.counterpartyApproved ? "bothApproved" : "awaitingPeer"}`,
                )}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" disabled={actionPending} onClick={exportApproval}>
                  {t(`${prefix}.export`)}
                </Button>
                {writable && history.data.canReauthorize ? (
                  <Button
                    variant="outline"
                    disabled={blocked}
                    onClick={() => {
                      focus.current =
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null;
                      reauthorize.reset();
                      setReauthorizing(true);
                    }}
                  >
                    {t(`${prefix}.reauthorize`)}
                  </Button>
                ) : null}
              </div>
              {history.data.ledger ? (
                <div className="space-y-2 text-sm">
                  <p role="status">{t(`${prefix}.states.${history.data.ledger.state}`)}</p>
                  {history.data.ledger.lastError ? (
                    <p role="alert">
                      {t(`${prefix}.errors.${history.data.ledger.lastError}`, {
                        defaultValue: t(`${prefix}.failed`),
                      })}
                    </p>
                  ) : null}
                  {writable &&
                  history.data.counterpartyApproved &&
                  history.data.ledger.state === "needs_review" ? (
                    <Button
                      variant="outline"
                      disabled={blocked || retry.isPending}
                      onClick={() => retry.mutate()}
                    >
                      {t("federation.commercial.actions.retry")}
                    </Button>
                  ) : null}
                  {history.data.ledger.transactionId ? (
                    <dl className="grid gap-4 sm:grid-cols-2">
                      <AgreementFact label={t("federation.commercial.transaction")}>
                        {history.data.ledger.transactionId}
                      </AgreementFact>
                      <AgreementFact label={t("federation.commercial.block")}>
                        {history.data.ledger.blockNumber ?? t("federation.commercial.unconfirmed")}
                      </AgreementFact>
                    </dl>
                  ) : null}
                </div>
              ) : null}
              <time
                className="block text-xs text-muted-foreground"
                dateTime={history.data.payload.issuedAt}
              >
                {new Date(history.data.payload.issuedAt).toLocaleString(i18n.language)}
              </time>
            </>
          ) : writable && !draft ? (
            <form
              className="max-w-2xl space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                generate.mutate();
              }}
            >
              <label htmlFor={`${id}-reason`} className="block text-sm font-medium">
                {t(`${prefix}.reason`)}
              </label>
              <Textarea
                id={`${id}-reason`}
                required
                maxLength={4096}
                value={reason}
                disabled={blocked}
                onChange={(event) => setReason(event.target.value)}
              />
              <Button type="submit" disabled={blocked || !reason.trim()}>
                {t(`${prefix}.draft`)}
              </Button>
            </form>
          ) : null}
          {writable && !history.data?.counterpartyApproved ? (
            <div className="max-w-2xl space-y-2">
              <label htmlFor={`${id}-import`} className="block text-sm font-medium">
                {t(`${prefix}.import`)}
              </label>
              <Input
                id={`${id}-import`}
                type="file"
                accept="application/json,.json"
                disabled={blocked || attach.isPending}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  try {
                    if (file.size > 2097152) throw new Error("Approval file too large");
                    const signed = CommercialHistoryRecoveryFileSchema.parse(
                      JSON.parse(await file.text()),
                    );
                    check(signed.payload);
                    if (!allowed.current || !active.current || pending.current) return;
                    if (history.data) {
                      if (
                        federationCanonicalJson(history.data.payload) !==
                        federationCanonicalJson(signed.payload)
                      )
                        throw new Error("Counterpart approved another record");
                      attach.mutate(signed.jws);
                    } else {
                      setDraft(signed.payload);
                      setPeerJws(signed.jws);
                    }
                    setMessage(null);
                  } catch {
                    setMessage(t(`${prefix}.invalidImport`));
                  }
                }}
              />
            </div>
          ) : null}
          {draft && !history.data && writable ? (
            <div className="flex gap-3">
              <Button
                disabled={blocked}
                onClick={() => {
                  focus.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  approve.reset();
                  setConfirming(true);
                }}
              >
                {t(`${prefix}.approve`)}
              </Button>
              <Button
                variant="outline"
                disabled={approve.isPending}
                onClick={() => {
                  setDraft(null);
                  setPeerJws(null);
                }}
              >
                {t("federation.cancel")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {message ? (
        <p role="alert" className="text-sm text-status-failed">
          {message}
        </p>
      ) : null}
      {generate.isError || attach.isError || retry.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {error(generate.error ?? attach.error ?? retry.error)}
        </p>
      ) : null}
      <Dialog
        open={confirming || reauthorizing}
        onOpenChange={(open) => {
          if (!approve.isPending && !reauthorize.isPending && !open) {
            setConfirming(false);
            setReauthorizing(false);
          }
        }}
      >
        <DialogContent
          dismissible={!approve.isPending && !reauthorize.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus.current?.isConnected && focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(`${prefix}.${reauthorizing ? "reauthorize" : "approve"}`)}</DialogTitle>
            <DialogDescription>
              {t(`${prefix}.${reauthorizing ? "reauthorizeEffect" : "effect"}`)}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {value ? (
              <div className="space-y-3 text-sm">
                <p className="break-words">{value.reason}</p>
                <AgreementFact label={t(`${prefix}.record`)}>
                  {value.originalRecordId}
                </AgreementFact>
                <AgreementFact label={t(`${prefix}.digest`)}>{value.originalDigest}</AgreementFact>
              </div>
            ) : null}
            {approve.isError || reauthorize.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {error(reauthorizing ? reauthorize.error : approve.error)}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={approve.isPending || reauthorize.isPending}
              onClick={() => {
                setConfirming(false);
                setReauthorizing(false);
              }}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                blocked || !writable || (reauthorizing ? !history.data?.canReauthorize : !draft)
              }
              onClick={() => (reauthorizing ? reauthorize.mutate() : approve.mutate())}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
