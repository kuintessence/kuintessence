import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, ServerCog, Star } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import {
  listSandboxAccountCandidates,
  listSandboxAccountMappings,
  requestSandboxAccountMapping,
  setDefaultSandboxAccountMapping,
} from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

function statusVariant(status: string) {
  if (status === "approved") return "succeeded" as const;
  if (status === "rejected" || status === "revoked" || status === "expired") {
    return "failed" as const;
  }
  return "pending" as const;
}

export function SandboxAccountMappingsPanel() {
  const { t } = useTranslation();
  const providerManagement = usePlatformCapability("workspace.provider.manage");
  const queryClient = useQueryClient();
  const [candidateId, setCandidateId] = useState("");
  const mappingsQuery = useQuery({
    queryKey: ["sandbox-account-mappings"],
    queryFn: listSandboxAccountMappings,
    retry: false,
  });
  const candidatesQuery = useQuery({
    queryKey: ["sandbox-account-candidates"],
    queryFn: listSandboxAccountCandidates,
    retry: false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["sandbox-account-mappings"] });
    void queryClient.invalidateQueries({ queryKey: ["sandbox-account-candidates"] });
  };
  const requestMutation = useMutation({
    mutationFn: requestSandboxAccountMapping,
    onSuccess: () => {
      setCandidateId("");
      refresh();
      toast.success(t("sandbox.accounts.requested"));
    },
    onError: (error) => toast.error(toUserFacingError(error, t("sandbox.accounts.requestFailed"))),
  });
  const defaultMutation = useMutation({
    mutationFn: setDefaultSandboxAccountMapping,
    onSuccess: () => {
      refresh();
      toast.success(t("sandbox.accounts.defaultUpdated"));
    },
    onError: (error) => toast.error(toUserFacingError(error, t("sandbox.accounts.defaultFailed"))),
  });
  const mappings = mappingsQuery.data ?? [];
  const activeAccountIds = new Set(
    mappings
      .filter(({ mapping }) => mapping.status === "pending" || mapping.status === "approved")
      .map((row) => row.account.id),
  );
  const allCandidates = candidatesQuery.data ?? [];
  const candidates = allCandidates.filter((candidate) => !activeAccountIds.has(candidate.id));
  const canManageCatalog = providerManagement.allowed;
  const candidateUnavailable = candidatesQuery.isLoading || candidatesQuery.isError;

  return (
    <Card data-testid="sandbox-account-mappings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          {t("sandbox.accounts.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-xs leading-5 text-muted-foreground">{t("sandbox.accounts.subtitle")}</p>
        <ol
          className="grid gap-2 sm:grid-cols-3"
          aria-label={t("sandbox.accounts.lifecycle.title")}
        >
          {["publish", "request", "approve"].map((step, index) => (
            <li key={step} className="flex items-center gap-2 rounded-md border bg-muted/25 p-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                {index + 1}
              </span>
              <span className="min-w-0 text-xs">
                <span className="block font-medium">
                  {t(`sandbox.accounts.lifecycle.${step}.title`)}
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  {t(`sandbox.accounts.lifecycle.${step}.description`)}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <select
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            aria-label={t("sandbox.accounts.candidate")}
            disabled={candidateUnavailable || candidates.length === 0}
            className="h-9 min-w-0 rounded-md border border-border bg-card px-3 text-sm"
          >
            <option value="">{t("sandbox.accounts.selectCandidate")}</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.siteName} · {candidate.displayName} · {candidate.schedulerType}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => requestMutation.mutate(candidateId)}
            disabled={candidateId === "" || requestMutation.isPending}
          >
            {t("sandbox.accounts.request")}
          </Button>
        </div>
        {candidatesQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("sandbox.accounts.loadingCandidates")}
          </div>
        ) : candidatesQuery.error instanceof Error ? (
          <div className="rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/5 p-3 text-sm text-[var(--status-failed)]">
            {toUserFacingError(candidatesQuery.error, t("sandbox.accounts.candidateLoadFailed"))}
          </div>
        ) : allCandidates.length === 0 ? (
          <div className="flex flex-col gap-3 rounded-md border border-dashed p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">{t("sandbox.accounts.noPublishedTitle")}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("sandbox.accounts.noPublishedDescription")}
              </p>
            </div>
            {canManageCatalog ? (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a href="/cp/accounts" target="_blank" rel="noreferrer">
                  {t("sandbox.accounts.manageCatalog")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-[var(--status-succeeded)]" />
            {t("sandbox.accounts.noMoreCandidates")}
          </div>
        ) : null}
        {mappingsQuery.error instanceof Error ? (
          <div className="text-sm text-[var(--status-failed)]">
            {toUserFacingError(mappingsQuery.error, t("sandbox.accounts.mappingLoadFailed"))}
          </div>
        ) : mappingsQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
        ) : mappings.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("sandbox.accounts.empty")}
          </div>
        ) : (
          <div className="grid gap-2">
            {mappings.map(({ account, mapping }) => (
              <div
                key={mapping.id}
                className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <ServerCog className="h-4 w-4 text-muted-foreground" />
                    <span>{account.displayName}</span>
                    <Badge variant={statusVariant(mapping.status)}>{mapping.status}</Badge>
                    {mapping.isDefault ? (
                      <Badge variant="brand">
                        <Star className="h-3 w-3" />
                        {t("sandbox.accounts.default")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {account.agentId} · {account.backendType}
                  </div>
                </div>
                {mapping.status === "approved" && !mapping.isDefault ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => defaultMutation.mutate(mapping.id)}
                    disabled={defaultMutation.isPending}
                  >
                    {t("sandbox.accounts.setDefault")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
