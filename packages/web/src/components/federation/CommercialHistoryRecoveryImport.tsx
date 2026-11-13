import { federationCanonicalJson } from "@kuintessence/shared/federation";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import {
  CommercialHistoryRecoveryFileSchema,
  CommercialHistoryRecoveryViewSchema,
} from "@kuintessence/shared/federation/history-recovery";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "../ui/input";
import { AgreementFact } from "./AgreementTerms";

export function CommercialHistoryRecoveryImport({
  approval,
  scope,
  writable,
  busy,
  onImported,
}: {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onImported: (submissionId: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const [file, setFile] = useState<ReturnType<
    typeof CommercialHistoryRecoveryFileSchema.parse
  > | null>(null);
  const [invalid, setInvalid] = useState(false);
  const allowed = useRef(false);
  allowed.current = writable && !busy && approval.terms.agreement.mode === "bilateral_attested";
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const focus = useRef<HTMLElement | null>(null);
  const matches = (value: NonNullable<typeof file>["payload"]) =>
    value.domainId === approval.terms.domainId &&
    value.agreementRevisionId === approval.revisionId &&
    value.sourceSiteId === approval.terms.agreement.sourceSiteId &&
    value.targetSiteId === approval.terms.agreement.targetSiteId;
  const mutation = useMutation({
    mutationFn: async () => {
      if (!allowed.current || !file || !matches(file.payload))
        throw new Error("History recovery import unavailable");
      const value = CommercialHistoryRecoveryViewSchema.parse(
        (
          await api.post<{ data: unknown }>(
            `/federation/commercial-agreements/${approval.revisionId}/history-recovery/import`,
            file,
            scope,
          )
        ).data,
      );
      if (
        !matches(value.payload) ||
        federationCanonicalJson(value.payload) !== federationCanonicalJson(file.payload) ||
        value.originalInput !== file.originalInput
      )
        throw new Error("Imported historical recovery mismatch");
      return value;
    },
    onSuccess: async (value) => {
      setFile(null);
      await client.invalidateQueries({
        queryKey: ["federation", "commercial", scope.organizationId, scope.authRevision],
      });
      if (allowed.current && active.current) onImported(value.original.id);
    },
  });
  useEffect(() => {
    if (!writable) setFile(null);
  }, [writable]);
  if (!writable || approval.terms.agreement.mode !== "bilateral_attested") return null;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <label className="block text-sm font-medium" htmlFor={id}>
        {t("federation.historyRecovery.import")}
      </label>
      <Input
        id={id}
        type="file"
        accept="application/json,.json"
        disabled={busy || mutation.isPending}
        onChange={async (event) => {
          const input = event.target.files?.[0];
          event.target.value = "";
          if (!input) return;
          try {
            if (input.size > 2097152) throw new Error("Recovery file too large");
            const value = CommercialHistoryRecoveryFileSchema.parse(JSON.parse(await input.text()));
            if (!matches(value.payload)) throw new Error("Foreign recovery file");
            if (!allowed.current || !active.current) return;
            focus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            mutation.reset();
            setFile(value);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.historyRecovery.invalidImport")}
        </p>
      ) : null}
      <Dialog
        open={file !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setFile(null);
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus.current?.isConnected && focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("federation.historyRecovery.approve")}</DialogTitle>
            <DialogDescription>{t("federation.historyRecovery.effect")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {file ? (
              <div className="space-y-3 text-sm">
                <p className="break-words">{file.payload.reason}</p>
                <AgreementFact label={t("federation.historyRecovery.record")}>
                  {file.payload.originalRecordId}
                </AgreementFact>
                <AgreementFact label={t("federation.historyRecovery.digest")}>
                  {file.payload.originalDigest}
                </AgreementFact>
                <AgreementFact label={t("federation.historyRecovery.inputDigest")}>
                  {file.payload.originalInputDigest}
                </AgreementFact>
              </div>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {mutation.error instanceof ApiError
                  ? t(`federation.historyRecovery.errors.${mutation.error.code}`, {
                      defaultValue: t("federation.historyRecovery.failed"),
                    })
                  : t("federation.historyRecovery.failed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setFile(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={busy || mutation.isPending || !writable || !file}
              onClick={() => mutation.mutate()}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
