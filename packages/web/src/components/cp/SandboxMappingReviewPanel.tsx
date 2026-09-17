import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  listSandboxMappingReviewQueue,
  reviewSandboxAccountMapping,
} from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function SandboxMappingReviewPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queueQuery = useQuery({
    queryKey: ["sandbox-account-mapping-review-queue"],
    queryFn: listSandboxMappingReviewQueue,
    retry: false,
  });
  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "approved" | "rejected" }) =>
      reviewSandboxAccountMapping(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sandbox-account-mapping-review-queue"] });
      toast.success(t("sandbox.accounts.reviewed"));
    },
    onError: (error) => toast.error(toUserFacingError(error, t("cp.data.failed"))),
  });
  const rows = queueQuery.data ?? [];

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4" />
            {t("sandbox.accounts.reviewTitle")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("sandbox.accounts.reviewSubtitle")}
          </p>
        </div>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      {queueQuery.error instanceof Error ? (
        <div className="text-sm text-[var(--status-failed)]">
          {toUserFacingError(queueQuery.error, t("cp.data.failed"))}
        </div>
      ) : queueQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("sandbox.accounts.reviewEmpty")}
        </div>
      ) : (
        <div className="grid gap-2">
          {rows.map(({ account, mapping }) => (
            <div
              key={mapping.id}
              className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between"
            >
              <div>
                <div className="text-sm font-medium">{account.displayName}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  user {mapping.userId} · {account.agentId} · {account.backendType}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => reviewMutation.mutate({ id: mapping.id, status: "approved" })}
                  disabled={reviewMutation.isPending}
                >
                  {t("sandbox.accounts.approve")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reviewMutation.mutate({ id: mapping.id, status: "rejected" })}
                  disabled={reviewMutation.isPending}
                >
                  {t("sandbox.accounts.reject")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
