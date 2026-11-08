import { FederationAttestationBacklogSchema } from "@kuintessence/shared/federation";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { AgreementFact } from "./AgreementTerms";

export function AgreementBacklog({
  scope,
  revisionId,
}: {
  scope: ApiOrganizationScope;
  revisionId: string;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const query = useQuery({
    queryKey: [
      "federation",
      "agreements",
      scope.organizationId,
      scope.authRevision,
      "backlog",
      revisionId,
    ],
    queryFn: async () => {
      const data = FederationAttestationBacklogSchema.parse(
        (await api.get<{ data: unknown }>(`/federation/agreements/${revisionId}/backlog`, scope))
          .data,
      );
      if (data.agreementRevisionId !== revisionId) throw new Error("Unexpected agreement backlog");
      return data;
    },
  });
  const data = query.data;
  const limits = data?.limits;
  const label = (name: string) =>
    `${t(`federation.agreements.backlog.${name}`)}${limits ? ` / ${t("federation.agreements.backlog.limit")}` : ""}`;
  const number = (value: string | number) => BigInt(value).toLocaleString(i18n.language);
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-sm font-semibold">
          {t("federation.agreements.backlog.title")}
        </h3>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t("federation.refresh")}
        </Button>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.loadFailed")}
        </p>
      ) : !data ? (
        <p role="status" className="text-sm">
          {t("federation.loading")}
        </p>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <AgreementFact label={label("tasks")}>
              {number(data.outstandingTasks)}
              {limits ? ` / ${number(limits.maxOutstandingTasks)}` : ""}
            </AgreementFact>
            <AgreementFact label={label("amount")}>
              {number(data.outstandingAmount)}
              {limits ? ` / ${number(limits.maxOutstandingAmount)}` : ""} {data.unit}
            </AgreementFact>
            <AgreementFact label={label("age")}>
              {data.oldestAgeSec === null ? (
                t("federation.agreements.backlog.none")
              ) : (
                <>
                  {t("federation.agreements.backlog.seconds", { value: number(data.oldestAgeSec) })}
                  {limits
                    ? ` / ${t("federation.agreements.backlog.seconds", { value: number(limits.maxOutstandingAgeSec) })}`
                    : ""}
                </>
              )}
            </AgreementFact>
          </dl>
          <p className="text-sm text-muted-foreground">
            {t("federation.agreements.backlog.scope")}
          </p>
          {!limits ? (
            <p role="status" className="text-sm">
              {t("federation.agreements.backlog.unconfigured")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("federation.agreements.backlog.observedAt")}{" "}
            {new Date(data.observedAt).toLocaleString(i18n.language)}
          </p>
        </>
      )}
    </section>
  );
}
