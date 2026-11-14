import {
  type FederationAgreement,
  type FederationAgreementApproval,
  FederationAgreementApprovalSchema,
  FederationAgreementContextSchema,
  FederationCurrentCapabilitiesSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
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
import { AgreementBacklog } from "./AgreementBacklog";
import { AgreementExchangeStatus } from "./AgreementExchangeStatus";
import { AgreementImport } from "./AgreementImport";
import { AgreementFact, AgreementTerms } from "./AgreementTerms";
import { FederationEmpty, FederationPanelHeader } from "./FederationLayout";

const path = "/federation/agreements";
type Action =
  | { kind: "sign"; terms: FederationAgreement; executionUserId?: string }
  | { kind: "attach"; revisionId: string; approvalJws: string }
  | { kind: "active" | "suspended" | "revoked" | "exchange"; revisionId: string };

export function AgreementPanel({
  scope,
  switching,
}: {
  scope: ApiOrganizationScope;
  switching: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ["federation", "agreements", scope.organizationId, scope.authRevision];
  const mobileReadOnly = useMobileMutationBlocked(path);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const currentCapabilities =
    !capabilities.isError && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = currentCapabilities.includes("agreement.read");
  const canApprove = currentCapabilities.includes("agreement.approve") && !mobileReadOnly;
  const context = useQuery({
    queryKey: [...key, "context"],
    enabled: canRead,
    queryFn: async () =>
      FederationAgreementContextSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/context`, scope)).data,
      ),
  });
  const list = useQuery({
    queryKey: [...key, "list", page],
    enabled: canRead,
    queryFn: async () =>
      z
        .array(FederationAgreementApprovalSchema)
        .parse(
          (await api.get<{ data: unknown }>(`${path}?limit=20&offset=${page * 20}`, scope)).data,
        ),
  });
  const detail = useQuery({
    queryKey: [...key, "detail", selected],
    enabled: canRead && !!selected,
    queryFn: async () =>
      FederationAgreementApprovalSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/${selected}`, scope)).data,
      ),
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!canApprove || switching) throw new Error("Agreement approval is unavailable");
      if (action.kind === "sign")
        await api.post(
          `${path}/approve`,
          {
            terms: action.terms,
            ...(action.executionUserId ? { executionUserId: action.executionUserId } : {}),
          },
          scope,
        );
      else if (action.kind === "attach")
        await api.post(
          `${path}/${action.revisionId}/counterparty`,
          { approvalJws: action.approvalJws },
          scope,
        );
      else if (action.kind === "exchange")
        await api.post(`${path}/${action.revisionId}/exchange/retry`, {}, scope);
      else await api.post(`${path}/${action.revisionId}/state`, { state: action.kind }, scope);
    },
    onSuccess: async (_, action) => {
      setConfirmation(null);
      setImporting(false);
      if (action.kind === "sign") setSelected(action.terms.agreementRevisionId);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const busy =
    switching ||
    mutation.isPending ||
    capabilities.isFetching ||
    context.isFetching ||
    context.isError ||
    !context.data;
  const confirm = (action: Action) => {
    mutation.reset();
    setConfirmation(action);
  };
  const refresh = () => {
    void capabilities.refetch();
    void client.invalidateQueries({ queryKey: key });
  };
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (capabilities.isError)
    return (
      <div role="alert">
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={refresh}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  if (!canRead)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("federation.agreements.noPermission")}
      </p>
    );
  return (
    <div className="space-y-5">
      <FederationPanelHeader title={t("federation.agreements.agreements")}>
        <Button
          variant="outline"
          disabled={
            switching ||
            mutation.isPending ||
            capabilities.isFetching ||
            context.isFetching ||
            list.isFetching
          }
          onClick={refresh}
        >
          {t("federation.refresh")}
        </Button>
        {canApprove && !importing ? (
          <Button
            disabled={busy}
            onClick={() => {
              setImporting(true);
              setSelected(null);
            }}
          >
            {t("federation.agreements.importTerms")}
          </Button>
        ) : null}
      </FederationPanelHeader>
      {mobileReadOnly ? (
        <p className="text-sm text-muted-foreground">{t("federation.agreements.desktopOnly")}</p>
      ) : null}
      {context.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t(
            context.error instanceof ApiError && context.error.status === 404
              ? "federation.agreements.notConfigured"
              : "federation.loadFailed",
          )}
        </p>
      ) : null}
      {importing && context.data && canApprove ? (
        <Card>
          <CardContent className="pt-5">
            <AgreementImport
              scope={scope}
              localSiteId={context.data.localSiteId}
              supportedModes={context.data.supportedModes}
              disabled={busy}
              onReview={(terms, executionUserId) =>
                confirm({ kind: "sign", terms, executionUserId })
              }
              onCancel={() => setImporting(false)}
            />
          </CardContent>
        </Card>
      ) : selected ? (
        <>
          <Button variant="ghost" disabled={mutation.isPending} onClick={() => setSelected(null)}>
            {t("federation.agreements.back")}
          </Button>
          {detail.isError ? (
            <p role="alert">{t("federation.loadFailed")}</p>
          ) : detail.isPending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <AgreementDetail
              key={detail.data.revisionId}
              approval={detail.data}
              scope={scope}
              writable={canApprove}
              busy={busy || detail.isFetching}
              onAction={confirm}
            />
          )}
        </>
      ) : list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {list.data.length ? (
            <ul className="federation-list divide-y divide-border rounded-md border border-border">
              {list.data.map((approval) => (
                <li key={approval.revisionId}>
                  <button
                    type="button"
                    className="federation-list-row flex w-full flex-col gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => setSelected(approval.revisionId)}
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="block break-all font-medium">
                        {approval.terms.sourceSiteId} → {approval.terms.targetSiteId}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {approval.revisionId}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm">
                      <span className="block">
                        {t(`federation.agreements.modes.${approval.terms.mode}`)}
                      </span>
                      <span className="block text-muted-foreground">
                        {t(`federation.agreements.localStates.${approval.state}`)} ·{" "}
                        {t(
                          approval.counterpartyApprovalJws
                            ? "federation.agreements.bothSigned"
                            : "federation.agreements.awaitingSignature",
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <FederationEmpty>{t("federation.agreements.empty")}</FederationEmpty>
          )}
          {page > 0 || list.data.length === 20 ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={page === 0 || list.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={list.data.length < 20 || list.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setConfirmation(null);
            mutation.reset();
          }
        }}
      >
        <DialogContent dismissible={!mutation.isPending} outsideDismissPolicy="never">
          <DialogHeader>
            <DialogTitle>
              {t(`federation.agreements.actions.${confirmation?.kind ?? "sign"}`)}
            </DialogTitle>
            <DialogDescription>
              {t(`federation.agreements.effects.${confirmation?.kind ?? "sign"}`)}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="break-all font-mono text-sm">
              {confirmation?.kind === "sign"
                ? confirmation.terms.agreementRevisionId
                : confirmation?.revisionId}
            </p>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.agreements.saveFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => {
                  setConfirmation(null);
                  mutation.reset();
                }}
              >
                {t("federation.cancel")}
              </Button>
              <Button
                disabled={busy || !canApprove || !confirmation}
                onClick={() => confirmation && mutation.mutate(confirmation)}
              >
                {t(mutation.isPending ? "federation.saving" : "federation.confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgreementDetail({
  approval,
  scope,
  writable,
  busy,
  onAction,
}: {
  approval: FederationAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onAction: (action: Action) => void;
}) {
  const { t } = useTranslation();
  const [signature, setSignature] = useState("");
  const [copyState, setCopyState] = useState<"copied" | "copyFailed" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(approval.approvalJws);
      setCopyState("copied");
    } catch {
      setCopyState("copyFailed");
    }
  };
  return (
    <Card>
      <CardContent className="space-y-6 pt-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <AgreementFact label={t("federation.agreements.localState")}>
            {t(`federation.agreements.localStates.${approval.state}`)}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.localSignature")}>
            {t("federation.agreements.signed")}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.counterpartySignature")}>
            {t(
              approval.counterpartyApprovalJws
                ? "federation.agreements.signed"
                : "federation.agreements.awaitingSignature",
            )}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.executionAccount")}>
            {approval.executionUserId ?? t("federation.agreements.notApplicable")}
          </AgreementFact>
        </dl>
        {writable && approval.state !== "revoked" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                onAction({
                  kind: approval.state === "active" ? "suspended" : "active",
                  revisionId: approval.revisionId,
                })
              }
            >
              {t(
                `federation.agreements.actions.${approval.state === "active" ? "suspended" : "active"}`,
              )}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => onAction({ kind: "revoked", revisionId: approval.revisionId })}
            >
              {t("federation.agreements.actions.revoked")}
            </Button>
          </div>
        ) : null}
        <AgreementExchangeStatus
          scope={scope}
          revisionId={approval.revisionId}
          writable={writable && approval.state === "active"}
          busy={busy}
          onRetry={() => onAction({ kind: "exchange", revisionId: approval.revisionId })}
        />
        <AgreementTerms terms={approval.terms} />
        {approval.localSiteId === approval.terms.targetSiteId &&
        approval.terms.mode === "bilateral_attested" ? (
          <AgreementBacklog scope={scope} revisionId={approval.revisionId} />
        ) : null}
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">{t("federation.agreements.localSignature")}</h3>
          <Button variant="outline" onClick={() => void copy()}>
            {t("federation.agreements.copySignature")}
          </Button>
          {copyState ? (
            <p role="status" className="text-sm">
              {t(`federation.agreements.${copyState}`)}
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm">
              {t("federation.agreements.viewSignature")}
            </summary>
            <Textarea
              className="mt-3 font-mono text-xs"
              aria-label={t("federation.agreements.localSignature")}
              readOnly
              rows={5}
              value={approval.approvalJws}
            />
            <dl className="mt-3">
              <AgreementFact label={t("federation.agreements.signedDigest")}>
                {approval.termsDigest}
              </AgreementFact>
            </dl>
          </details>
        </section>
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">
            {t("federation.agreements.counterpartySignature")}
          </h3>
          {approval.counterpartyApprovalJws ? (
            <Textarea
              aria-label={t("federation.agreements.counterpartySignature")}
              readOnly
              rows={5}
              className="font-mono text-xs"
              value={approval.counterpartyApprovalJws}
            />
          ) : writable && approval.state !== "revoked" ? (
            <>
              <Textarea
                aria-label={t("federation.agreements.counterpartySignature")}
                disabled={busy}
                rows={5}
                maxLength={524288}
                value={signature}
                onChange={(event) => setSignature(event.target.value)}
                className="font-mono text-xs"
              />
              <Button
                disabled={busy || !signature.trim()}
                onClick={() =>
                  onAction({
                    kind: "attach",
                    revisionId: approval.revisionId,
                    approvalJws: signature.trim(),
                  })
                }
              >
                {t("federation.agreements.actions.attach")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("federation.agreements.awaitingSignature")}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
