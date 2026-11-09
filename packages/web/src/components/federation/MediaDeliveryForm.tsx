import {
  FederationAnyMediaExportApprovalSchema,
  FederationMediaImportApprovalSchema,
  FederationMediaRegistrationSchema,
  FederationMediaRevocationSchema,
  MediaExportOperationSchema,
  MediaExportSummarySchema,
  MediaImportAuthorizationSchema,
  MediaImportOperationSchema,
  MediaPackageDetailSchema,
  MediaPackageSummarySchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import type { MediaScope } from "./MediaLogisticsShared";
import { type MediaOption, MediaOptionPicker, type MediaTaskOption } from "./MediaOptionPicker";

export type MediaDeliveryAction =
  | { kind: "export"; workflowRunId?: string; taskKind?: "task-input" | "task-result" }
  | { kind: "register"; workflowRunId?: string }
  | { kind: "approve"; packageId: string; sizeBytes: number }
  | {
      kind: "run" | "revoke";
      packageId: string;
      direction: "exports" | "packages";
      authorizationId?: string;
    }
  | { kind: "retryReceipt"; packageId: string; authorizationId: string };
export function mediaActionCapability(action: MediaDeliveryAction) {
  return action.kind === "export" ||
    ((action.kind === "run" || action.kind === "revoke") && action.direction === "exports")
    ? "media.export"
    : action.kind === "register" || (action.kind === "revoke" && !action.authorizationId)
      ? "asset.map"
      : "media.import";
}
type Intent = { path: string; body: unknown };
export function MediaDeliveryForm({
  scope,
  action,
  busy,
  onCancel,
  onSaved,
}: {
  scope: MediaScope;
  action: MediaDeliveryAction;
  busy: boolean;
  onCancel: () => void;
  onSaved: (id?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const [subject, setSubject] = useState<"task-input" | "task-result" | "dataset">(
    action.kind === "export" ? (action.taskKind ?? "task-input") : "task-input",
  );
  const [task, setTask] = useState<MediaTaskOption | null>(null);
  const [tasksReady, setTasksReady] = useState(false);
  const [agreement, setAgreement] = useState<
    Extract<MediaOption, { kind: "agreements" }>["value"] | null
  >(null);
  const [agent, setAgent] = useState("");
  const [agreementsReady, setAgreementsReady] = useState(false);
  const [agentsReady, setAgentsReady] = useState(false);
  const [rootsReady, setRootsReady] = useState(false);
  const [root, setRoot] = useState("");
  const [dataset, setDataset] = useState<
    Extract<MediaOption, { kind: "datasets" }>["value"] | null
  >(null);
  const [datasetsReady, setDatasetsReady] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [bytes, setBytes] = useState(action.kind === "approve" ? String(action.sizeBytes) : "");
  const [reason, setReason] = useState("");
  const [registration, setRegistration] = useState<z.infer<
    typeof FederationMediaRegistrationSchema
  > | null>(null);
  const [reading, setReading] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const optionsReady =
    action.kind === "export"
      ? subject === "dataset"
        ? agreementsReady && datasetsReady
        : tasksReady && agentsReady
      : action.kind === "approve"
        ? agentsReady && rootsReady
        : true;
  const allowed = useRef(!busy && optionsReady);
  allowed.current = !busy && optionsReady;
  const fileRevision = useRef(0);
  const send = useMutation({
    retry: false,
    mutationFn: async (request: Intent) => {
      if (!allowed.current) throw new Error("Media action unavailable");
      const response = await api.post<{ data?: unknown; success?: boolean }>(
        request.path,
        request.body,
        scope,
      );
      if (action.kind === "export") {
        const input = FederationAnyMediaExportApprovalSchema.parse(request.body);
        const saved = MediaExportSummarySchema.parse(response.data);
        if (
          saved.packageId !== input.packageId ||
          saved.agreementRevisionId !== input.agreementRevisionId ||
          saved.recipientSiteId !== input.recipientSiteId ||
          Date.parse(saved.expiresAt) !== Date.parse(input.expiresAt) ||
          ("kind" in input
            ? saved.taskSelection?.kind !== input.kind ||
              saved.taskSelection.operationId !== input.operationId ||
              saved.taskSelection.agentId !== input.agentId ||
              saved.versionId !== null ||
              saved.locationId !== null
            : saved.versionId !== input.versionId ||
              saved.locationId !== input.locationId ||
              saved.taskSelection !== null)
        )
          throw new Error("Media export response mismatch");
        return saved.packageId;
      }
      if (action.kind === "register") {
        const input = FederationMediaRegistrationSchema.parse(request.body);
        const saved = MediaPackageSummarySchema.parse(response.data);
        if (
          saved.senderSiteId !== input.senderSiteId ||
          saved.recipientSiteId !== scope.localSiteId
        )
          throw new Error("Media registration response mismatch");
        const detail = MediaPackageDetailSchema.parse(
          (await api.get<{ data: unknown }>(`/federation/media/packages/${saved.packageId}`, scope))
            .data,
        );
        if (
          detail.packageId !== saved.packageId ||
          detail.signedManifest !== input.signedManifest ||
          detail.senderSiteId !== input.senderSiteId ||
          detail.recipientSiteId !== scope.localSiteId
        )
          throw new Error("Media registered manifest mismatch");
        return saved.packageId;
      }
      if (action.kind === "approve") {
        const input = FederationMediaImportApprovalSchema.parse(request.body);
        const saved = MediaImportAuthorizationSchema.parse(response.data);
        if (
          saved.packageId !== action.packageId ||
          saved.localSiteId !== scope.localSiteId ||
          saved.authorizationId !== input.authorizationId ||
          saved.agentId !== input.agentId ||
          saved.managedRootId !== input.managedRootId ||
          saved.maxBytes !== input.maxBytes ||
          Date.parse(saved.expiresAt) !== Date.parse(input.expiresAt)
        )
          throw new Error("Media approval response mismatch");
      } else if (action.kind === "run") {
        if (action.direction === "exports") {
          const saved = MediaExportOperationSchema.parse(response.data);
          if (saved.packageId !== action.packageId || saved.localSiteId !== scope.localSiteId)
            throw new Error("Media export operation mismatch");
        } else {
          const saved = MediaImportOperationSchema.parse(response.data);
          if (saved.authorizationId !== action.authorizationId)
            throw new Error("Media import operation mismatch");
        }
      } else z.object({ success: z.literal(true) }).parse(response);
      return action.packageId;
    },
    onSuccess: onSaved,
  });
  const blocked = busy || send.isPending || reading || !optionsReady;
  const locked = busy || send.isPending || reading || !!intent;
  const build = (): Intent => {
    const base = "/federation/media";
    if (action.kind === "register")
      return {
        path: `${base}/packages${action.workflowRunId ? `?workflowRunId=${encodeURIComponent(action.workflowRunId)}` : ""}`,
        body: FederationMediaRegistrationSchema.parse(registration),
      };
    if (action.kind === "export")
      return {
        path: `${base}/exports`,
        body: FederationAnyMediaExportApprovalSchema.parse({
          packageId: crypto.randomUUID(),
          agreementRevisionId:
            subject === "dataset" ? agreement?.revisionId : task?.agreementRevisionId,
          recipientSiteId: subject === "dataset" ? agreement?.peerSiteId : task?.recipientSiteId,
          expiresAt: new Date(expiry).toISOString(),
          ...(subject === "dataset"
            ? { versionId: dataset?.versionId, locationId: dataset?.locationId }
            : { kind: subject, operationId: task?.operationId, agentId: agent }),
        }),
      };
    if (action.kind === "approve")
      return {
        path: `${base}/packages/${action.packageId}/import-authorizations`,
        body: FederationMediaImportApprovalSchema.parse({
          authorizationId: crypto.randomUUID(),
          agentId: agent,
          managedRootId: root,
          maxBytes: bytes.trim() ? Number(bytes) : undefined,
          expiresAt: new Date(expiry).toISOString(),
        }),
      };
    const path = `${base}/${action.kind === "retryReceipt" ? "packages" : action.direction}/${action.packageId}${action.authorizationId ? `/import-authorizations/${action.authorizationId}` : ""}`;
    return {
      path: `${path}/${action.kind === "retryReceipt" ? "receipt/retry" : action.kind}`,
      body: action.kind === "revoke" ? FederationMediaRevocationSchema.parse({ reason }) : {},
    };
  };
  const field = (name: string, value: string, change: (value: string) => void, type = "text") => (
    <div className="min-w-0 space-y-2">
      <label htmlFor={`${id}-${name}`} className="text-sm font-medium">
        {t(`federation.delivery.${name}`)}
      </label>
      <Input
        id={`${id}-${name}`}
        type={type}
        value={value}
        required
        onChange={(event) => change(event.target.value)}
      />
    </div>
  );
  return (
    <form
      className="space-y-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || intent) return;
        try {
          const next = build();
          setInvalid(false);
          setIntent(next);
          send.mutate(next);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <h3 className="text-lg font-semibold">
        {t(
          `federation.delivery.actions.${action.kind === "revoke" && action.authorizationId ? "revokeApproval" : action.kind}`,
        )}
      </h3>
      {"packageId" in action ? (
        <code className="block break-all text-xs">
          {("authorizationId" in action && action.authorizationId) || action.packageId}
        </code>
      ) : null}
      <fieldset disabled={locked} className="grid min-w-0 gap-4 sm:grid-cols-2">
        {action.kind === "export" ? (
          <>
            <div className="space-y-2">
              <label htmlFor={`${id}-subject`} className="text-sm font-medium">
                {t("federation.delivery.subject")}
              </label>
              <select
                id={`${id}-subject`}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={subject}
                disabled={!!action.taskKind}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value !== "task-input" && value !== "task-result" && value !== "dataset")
                    return;
                  setSubject(value);
                  setTask(null);
                  setDataset(null);
                  setAgreement(null);
                  setDatasetsReady(false);
                  setAgreementsReady(false);
                  setTasksReady(false);
                }}
              >
                {["task-input", "task-result", "dataset"].map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`federation.delivery.kinds.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            {subject === "dataset" ? (
              <MediaOptionPicker
                scope={scope}
                kind="agreements"
                onAvailable={setAgreementsReady}
                selected={agreement?.revisionId ?? ""}
                disabled={locked}
                onChange={(option) => {
                  if (option.kind === "agreements") setAgreement(option.value);
                }}
              />
            ) : (
              <MediaOptionPicker
                key={`${subject}:${action.workflowRunId ?? ""}`}
                scope={scope}
                kind={subject}
                workflowRunId={action.workflowRunId}
                disabled={locked}
                selected={task ? `${task.agreementRevisionId}:${task.operationId}` : ""}
                onAvailable={setTasksReady}
                onChange={(option) => {
                  if (option.kind === subject) setTask(option.value);
                }}
              />
            )}
            {subject === "dataset" ? (
              <MediaOptionPicker
                scope={scope}
                kind="datasets"
                selected={dataset?.locationId ?? ""}
                disabled={locked}
                onAvailable={setDatasetsReady}
                onChange={(option) => {
                  if (option.kind === "datasets") setDataset(option.value);
                }}
              />
            ) : null}
          </>
        ) : null}
        {action.kind === "approve" || (action.kind === "export" && subject !== "dataset") ? (
          <MediaOptionPicker
            scope={scope}
            kind="agents"
            onAvailable={setAgentsReady}
            selected={agent}
            disabled={locked}
            onChange={(option) => {
              if (option.kind === "agents") {
                setAgent(option.value.agentId);
                setRoot("");
                setRootsReady(false);
              }
            }}
          />
        ) : null}
        {action.kind === "approve" ? (
          <>
            <MediaOptionPicker
              key={agent}
              scope={scope}
              kind="roots"
              onAvailable={setRootsReady}
              agentId={agent}
              selected={root}
              disabled={locked}
              onChange={(option) => {
                if (option.kind === "roots") setRoot(option.value.id);
              }}
            />
            {field("maxBytes", bytes, setBytes, "number")}
          </>
        ) : null}
        {action.kind === "export" || action.kind === "approve"
          ? field("expiresAt", expiry, setExpiry, "datetime-local")
          : null}
        {action.kind === "register" ? (
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor={`${id}-file`} className="text-sm font-medium">
              {t("federation.delivery.manifestFile")}
            </label>
            <Input
              id={`${id}-file`}
              type="file"
              accept=".json,application/json"
              required
              onChange={async (event) => {
                const file = event.target.files?.[0],
                  revision = ++fileRevision.current;
                setRegistration(null);
                setInvalid(false);
                if (!file) return;
                setReading(true);
                try {
                  if (file.size > 530_000) throw new Error("Manifest file exceeds limit");
                  const parsed = FederationMediaRegistrationSchema.parse(
                    JSON.parse(await file.text()),
                  );
                  if (revision === fileRevision.current) setRegistration(parsed);
                } catch {
                  if (revision === fileRevision.current) setInvalid(true);
                } finally {
                  if (revision === fileRevision.current) setReading(false);
                }
              }}
            />
            {registration ? (
              <code className="block break-all text-xs">{registration.senderSiteId}</code>
            ) : null}
          </div>
        ) : null}
        {action.kind === "revoke" ? (
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor={`${id}-reason`} className="text-sm font-medium">
              {t("federation.delivery.reason")}
            </label>
            <Textarea
              id={`${id}-reason`}
              required
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        ) : null}
      </fieldset>
      {invalid ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.delivery.invalid")}
        </p>
      ) : null}
      {send.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.delivery.unconfirmed")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {send.isError && intent ? (
          <Button type="button" disabled={blocked} onClick={() => send.mutate(intent)}>
            {t("federation.logistics.retry")}
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={locked || !optionsReady || (action.kind === "register" && !registration)}
          >
            {t(
              `federation.delivery.actions.${action.kind === "revoke" && action.authorizationId ? "revokeApproval" : action.kind}`,
            )}
          </Button>
        )}
        {send.isError ? (
          <Button
            type="button"
            variant="outline"
            disabled={send.isPending}
            onClick={() =>
              void client.invalidateQueries({
                queryKey: ["federation", "media", scope.organizationId, scope.authRevision],
              })
            }
          >
            {t("federation.refresh")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={send.isPending} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </form>
  );
}
