import {
  MediaOptionsSchema,
  type MediaTaskOptionSchema,
  MediaTaskOptionsSchema,
} from "@kuintessence/shared/federation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import { api } from "../../lib/api-client";
import { compactUuid, statusLabel } from "../../lib/format";
import { Button } from "../ui/button";
import { checkMediaScope, MediaPagination, type MediaScope } from "./MediaLogisticsShared";

type Options = z.infer<typeof MediaOptionsSchema>;
export type MediaTaskOption = z.infer<typeof MediaTaskOptionSchema>;
export type MediaOption =
  | { kind: "agreements"; value: Extract<Options, { kind: "agreements" }>["data"][number] }
  | { kind: "agents"; value: Extract<Options, { kind: "agents" }>["data"][number] }
  | { kind: "datasets"; value: Extract<Options, { kind: "datasets" }>["data"][number] }
  | { kind: "roots"; value: Extract<Options, { kind: "roots" }>["data"][number] }
  | { kind: "task-input" | "task-result"; value: MediaTaskOption };
export function MediaOptionPicker({
  scope,
  kind,
  agentId,
  workflowRunId,
  selected,
  disabled,
  onChange,
  onAvailable,
}: {
  scope: MediaScope;
  kind: Options["kind"] | "task-input" | "task-result";
  workflowRunId?: string;
  agentId?: string;
  selected: string;
  disabled: boolean;
  onChange: (option: MediaOption) => void;
  onAvailable: (available: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [page, setPage] = useState(0);
  const task = kind === "task-input" || kind === "task-result";
  const query = useQuery({
    queryKey: [
      "federation",
      "media",
      scope.organizationId,
      scope.authRevision,
      "options",
      kind,
      agentId,
      page,
      ...(task ? [workflowRunId ?? null] : []),
    ],
    enabled: kind !== "roots" || !!agentId,
    queryFn: async () => {
      const params = new URLSearchParams({ kind, limit: "20", offset: String(page * 20) });
      if (agentId) params.set("agentId", agentId);
      if (task && workflowRunId) params.set("workflowRunId", workflowRunId);
      const raw = await api.get(`/federation/media/${task ? "tasks" : "options"}?${params}`, scope);
      const result = checkMediaScope(
        task ? MediaTaskOptionsSchema.parse(raw) : MediaOptionsSchema.parse(raw),
        scope,
      );
      if ("workflowRunId" in result && result.workflowRunId !== (workflowRunId ?? null))
        throw new Error("Media workflow scope mismatch");
      if (result.kind !== kind || (result.kind === "roots" && result.agentId !== agentId))
        throw new Error("Media option scope mismatch");
      return result;
    },
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    onAvailable(query.isSuccess && !query.isError && !query.isFetching);
  }, [onAvailable, query.isSuccess, query.isError, query.isFetching]);
  const rows: { id: string; label: string; option: MediaOption }[] =
    !query.isError && query.data
      ? query.data.kind === "agreements"
        ? query.data.data.map((value) => ({
            id: value.revisionId,
            label: `${value.peerName} · ${compactUuid(value.revisionId)} · ${new Date(value.validUntil).toLocaleDateString(i18n.language)}`,
            option: { kind: "agreements", value },
          }))
        : query.data.kind === "agents"
          ? query.data.data.map((value) => ({
              id: value.agentId,
              label: `${value.name} · ${statusLabel(value.status, i18n.language)}`,
              option: { kind: "agents", value },
            }))
          : query.data.kind === "roots"
            ? query.data.data.map((value) => ({
                id: value.id,
                label: value.label,
                option: { kind: "roots", value },
              }))
            : query.data.kind === "datasets"
              ? query.data.data.map((value) => ({
                  id: value.locationId,
                  label: `${value.name} · ${value.version} · ${value.agentName} / ${value.rootLabel}`,
                  option: { kind: "datasets", value },
                }))
              : query.data.data.map((value) => ({
                  id: `${value.agreementRevisionId}:${value.operationId}`,
                  label: `${value.workflowName} · ${value.invocationPath ?? compactUuid(value.operationId)}`,
                  option: { kind: kind === "task-input" ? "task-input" : "task-result", value },
                }))
      : [];
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {t(`federation.delivery.${task ? "task" : kind}`)}
      </label>
      {query.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          {t("federation.loadFailed")}
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {t("federation.refresh")}
          </Button>
        </div>
      ) : (
        <>
          <select
            id={id}
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
            disabled={disabled || query.isFetching || !rows.length}
            value={rows.some((row) => row.id === selected) ? selected : ""}
            onChange={(event) => {
              const row = rows.find((item) => item.id === event.target.value);
              if (row) onChange(row.option);
            }}
          >
            <option value="" disabled>
              {t(
                query.isFetching
                  ? "federation.loading"
                  : rows.length
                    ? "federation.delivery.choose"
                    : "federation.delivery.noOptions",
              )}
            </option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
                {rows.some((other) => other.id !== row.id && other.label === row.label)
                  ? ` · ${compactUuid(row.id)}`
                  : ""}
              </option>
            ))}
          </select>
          {selected ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t("federation.delivery.selectedIdentifier")}
              </summary>
              <code className="mt-1 block break-all">{selected}</code>
            </details>
          ) : null}
        </>
      )}
      <MediaPagination
        page={page}
        hasMore={query.data?.hasMore ?? false}
        busy={disabled || query.isFetching || query.isError}
        onChange={setPage}
      />
    </div>
  );
}
