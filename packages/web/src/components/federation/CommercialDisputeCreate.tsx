import { federationCanonicalJson } from "@kuintessence/shared/federation";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import {
  type CommercialDispute,
  CommercialDisputeRecordSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { useMutation } from "@tanstack/react-query";
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
import { Textarea } from "../ui/input";
import { AgreementFact } from "./AgreementTerms";

export function CommercialDisputeCreate({
  subject,
  approval,
  scope,
  writable,
  busy,
  onCancel,
  onOpened,
}: {
  subject: CommercialDispute["subject"];
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onCancel: () => void;
  onOpened: (caseId: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const allowed = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  allowed.current = writable && !busy;
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<CommercialDispute | null>(null);
  const [confirming, setConfirming] = useState(false);
  const focus = useRef<HTMLElement | null>(null);
  const base = `/federation/commercial-agreements/${approval.revisionId}/disputes`;
  const check = (value: CommercialDispute) => {
    if (
      value.domainId !== approval.terms.domainId ||
      value.agreementRevisionId !== approval.revisionId ||
      value.agreementDigest !== approval.digest ||
      value.sourceSiteId !== approval.terms.agreement.sourceSiteId ||
      value.targetSiteId !== approval.terms.agreement.targetSiteId ||
      value.openingSiteId !== approval.localSiteId ||
      federationCanonicalJson(value.subject) !== federationCanonicalJson(subject)
    )
      throw new Error("Dispute scope mismatch");
    return value;
  };
  const generate = useMutation({
    mutationFn: async () => {
      if (!allowed.current) throw new Error("Dispute drafting unavailable");
      const current = generation.current;
      const input = {
        caseId: crypto.randomUUID(),
        subject,
        reason: reason.trim(),
        requestedResolution: request.trim(),
      };
      const value = check(
        CommercialDisputeSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/draft`, input, scope)).data,
        ),
      );
      if (
        value.caseId !== input.caseId ||
        value.reason !== input.reason ||
        value.requestedResolution !== input.requestedResolution
      )
        throw new Error("Dispute draft mismatch");
      return { value, current };
    },
    onSuccess: ({ value, current }) => {
      if (!allowed.current || current !== generation.current) return;
      setDraft(value);
      setConfirming(true);
    },
  });
  const open = useMutation({
    mutationFn: async (value: CommercialDispute) => {
      if (!allowed.current) throw new Error("Dispute opening unavailable");
      const row = CommercialDisputeRecordSchema.parse(
        (await api.post<{ data: unknown }>(`${base}/open`, check(value), scope)).data,
      );
      if (
        row.localOrgId !== scope.organizationId ||
        row.localSiteId !== approval.localSiteId ||
        federationCanonicalJson(row.payload) !== federationCanonicalJson(value)
      )
        throw new Error("Opened dispute mismatch");
      return row.caseId;
    },
    onSuccess: (caseId) => {
      if (allowed.current) onOpened(caseId);
    },
  });
  useEffect(() => {
    if (!writable) {
      generation.current += 1;
      setDraft(null);
      setConfirming(false);
    }
  }, [writable]);
  const uncertain =
    open.isError &&
    !(open.error instanceof ApiError && [400, 403, 409].includes(open.error.status));
  const pending = busy || generate.isPending || open.isPending;
  const error = open.error ?? generate.error;
  return (
    <section className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{t("federation.dispute.openCase")}</h3>
        <Button variant="ghost" disabled={pending || uncertain} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <AgreementFact label={t("federation.dispute.subjectType")}>
          {t(`federation.dispute.subjects.${subject.recordType}`)}
        </AgreementFact>
        <AgreementFact label={t("federation.dispute.subjectRecord")}>
          {subject.recordId}
        </AgreementFact>
      </dl>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          focus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          if (uncertain && draft) setConfirming(true);
          else {
            open.reset();
            generate.mutate();
          }
        }}
      >
        <label htmlFor={`${id}-reason`} className="block space-y-1 text-sm">
          <span>{t("federation.dispute.openReason")}</span>
          <Textarea
            id={`${id}-reason`}
            required
            maxLength={4096}
            rows={3}
            disabled={pending || uncertain || !writable}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-request`} className="block space-y-1 text-sm">
          <span>{t("federation.dispute.requestedResolution")}</span>
          <Textarea
            id={`${id}-request`}
            required
            maxLength={4096}
            rows={3}
            disabled={pending || uncertain || !writable}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-status-failed">
            {error instanceof ApiError
              ? t(`federation.dispute.errors.${error.code}`, {
                  defaultValue: t("federation.dispute.failed"),
                })
              : t("federation.dispute.failed")}
          </p>
        ) : null}
        <Button disabled={pending || !writable || !reason.trim() || !request.trim()}>
          {t(uncertain ? "federation.dispute.retryOpen" : "federation.dispute.reviewCase")}
        </Button>
      </form>
      <Dialog
        open={confirming}
        onOpenChange={(value) => {
          if (!open.isPending) setConfirming(value);
        }}
      >
        <DialogContent
          dismissible={!open.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus.current?.isConnected && focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("federation.dispute.openCase")}</DialogTitle>
            <DialogDescription>{t("federation.dispute.openConfirmation")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="break-words text-sm">{draft?.reason}</p>
            <p className="break-words text-sm">{draft?.requestedResolution}</p>
            {open.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.dispute.failed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={open.isPending}
              onClick={() => setConfirming(false)}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={pending || !writable || !draft}
              onClick={() => draft && open.mutate(draft)}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
