import {
  FederationCurrentCapabilitiesSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { CommercialEvidenceCaseInputSchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EvidenceCaseDetail } from "./EvidenceCaseDetail";
import { type EvidenceCase, EvidenceCaseSchema } from "./evidence-case-view";

const path = "/federation/evidence-cases";
export function FederationEvidencePanel({
  scope,
  switching,
}: {
  scope: ApiOrganizationScope;
  switching: boolean;
}) {
  return (
    <EvidencePanel
      key={`${scope.organizationId}:${scope.authRevision}`}
      scope={scope}
      switching={switching}
    />
  );
}
function EvidencePanel({ scope, switching }: { scope: ApiOrganizationScope; switching: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const readOnly = useMobileMutationBlocked(path);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<EvidenceCase | null>(null);
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState(false);
  const pending = useRef<z.infer<typeof CommercialEvidenceCaseInputSchema> | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    refetchOnWindowFocus: false,
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const grants =
    !capabilities.isError && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = grants.includes("disclosure.receive");
  const allowed = useRef(false);
  allowed.current = canRead && !readOnly && !switching;
  const check = (raw: unknown) => {
    const row = EvidenceCaseSchema.parse(raw);
    if (row.localOrgId !== scope.organizationId) throw new Error("Evidence organization mismatch");
    return row;
  };
  const list = useQuery({
    queryKey: ["federation", "evidence", scope.organizationId, scope.authRevision, page],
    enabled: canRead,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const rows = z
        .object({ data: z.unknown().array().max(20), hasMore: z.boolean() })
        .parse(await api.get(`${path}?limit=20&offset=${page * 20}`, scope));
      return { ...rows, data: rows.data.map(check) };
    },
  });
  const register = useMutation({
    retry: false,
    mutationFn: async (context: z.infer<typeof CommercialEvidenceCaseInputSchema>) => {
      if (!active.current || !allowed.current) throw new Error("Evidence registration unavailable");
      const row = check(await api.post(path, context, scope));
      if (federationCanonicalJson(row.context) !== federationCanonicalJson(context))
        throw new Error("Registered case differs from request");
      return row;
    },
    onSuccess: (row) => {
      if (!active.current) return;
      pending.current = null;
      setSelected(row);
      setCreating(false);
      setValues({});
      void list.refetch();
    },
  });
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (capabilities.isError)
    return (
      <div role="alert">
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={() => void capabilities.refetch()}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  if (!canRead) return <p>{t("federation.agreements.noPermission")}</p>;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={switching || register.isPending}
          onClick={() => {
            void capabilities.refetch();
            void list.refetch();
          }}
        >
          {t("federation.refresh")}
        </Button>
        {selected ? (
          <Button variant="outline" onClick={() => setSelected(null)}>
            {t("federation.evidence.back")}
          </Button>
        ) : allowed.current ? (
          <Button disabled={register.isPending} onClick={() => setCreating(!creating)}>
            {t(creating ? "federation.cancel" : "federation.evidence.register")}
          </Button>
        ) : null}
      </div>
      {creating && !selected && allowed.current ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const context = pending.current ?? CommercialEvidenceCaseInputSchema.parse(values);
              pending.current = context;
              setInvalid(false);
              register.mutate(context);
            } catch {
              setInvalid(true);
            }
          }}
        >
          <fieldset
            disabled={register.isPending || !!pending.current}
            className="grid gap-4 sm:grid-cols-2"
          >
            {CommercialEvidenceCaseInputSchema.keyof().options.map((key) => (
              <label key={key} htmlFor={`${id}-${key}`} className="grid gap-1 text-sm">
                {t(`federation.evidence.fields.${key}`)}
                <Input
                  required
                  id={`${id}-${key}`}
                  value={values[key] ?? ""}
                  onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                />
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={register.isPending}>
            {t(pending.current ? "federation.governance.recover" : "federation.evidence.register")}
          </Button>
          {invalid || register.isError ? (
            <p role="alert">
              {t(
                register.isError
                  ? "federation.evidence.registerUnknown"
                  : "federation.governance.invalid",
              )}
            </p>
          ) : null}
        </form>
      ) : null}
      {selected ? (
        <EvidenceCaseDetail
          key={selected.caseId}
          row={selected}
          scope={scope}
          grants={grants}
          readOnly={readOnly}
          busy={switching || capabilities.isFetching}
          onClosed={(row) => {
            setSelected(row);
            void list.refetch();
          }}
        />
      ) : list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.data.data.map((row) => (
              <li key={row.caseId}>
                <button
                  className="flex w-full flex-wrap justify-between gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  type="button"
                  onClick={() => setSelected(row)}
                >
                  <span className="min-w-0 break-all">{row.caseId}</span>
                  <span>
                    {t(row.closedAt ? "federation.evidence.closed" : "federation.evidence.open")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!list.data.data.length ? <p>{t("federation.evidence.empty")}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!page || switching}
              onClick={() => setPage(page - 1)}
            >
              {t("federation.previous")}
            </Button>
            <Button
              variant="outline"
              disabled={!list.data.hasMore || switching}
              onClick={() => setPage(page + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
