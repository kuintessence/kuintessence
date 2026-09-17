import type {
  PlannerMode,
  SandboxLanguage,
  ScriptInputSpec,
  ScriptOutputSpec,
} from "@kuintessence/shared/browser";
import { workflowDsl } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  CloudOff,
  FileCode2,
  FlaskConical,
  Gauge,
  Play,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError } from "../../lib/api-client";
import {
  createSandboxScript,
  createSandboxScriptRevision,
  deleteSandboxScript,
  getSandboxScript,
  listSandboxRuntimeProfiles,
  renderSandboxPrompt,
  runSandboxScriptTest,
  type SandboxScriptPayload,
  type SandboxScriptWrite,
} from "../../lib/sandbox-client";
import { softwareCatalogDestination } from "../../lib/software-navigation";
import { useSoftwarePublishingAccess } from "../../lib/software-publishing-access";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
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
import { PageHeader, PageShell } from "../ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { SandboxCodeEditor } from "./SandboxCodeEditor";

const CODE_TEMPLATES: Record<SandboxLanguage, string> = {
  python: `import json
from pathlib import Path

context = json.loads(Path("/kq/context.json").read_text())
source = Path("/kq/inputs/input").read_text()
Path("/kq/outputs/output").write_text(source)
`,
  nodejs: `import { readFileSync, writeFileSync } from "node:fs";

const context = JSON.parse(readFileSync("/kq/context.json", "utf8"));
const source = readFileSync("/kq/inputs/input", "utf8");
writeFileSync("/kq/outputs/output", source);
`,
  bash: `#!/usr/bin/env bash
set -euo pipefail

jq . /kq/context.json >/dev/null
cp /kq/inputs/input /kq/outputs/output
`,
};

const DEFAULT_INPUTS: Record<string, ScriptInputSpec> = {
  input: { type: "File", required: true },
};

const DEFAULT_OUTPUTS: Record<string, ScriptOutputSpec> = {
  output: {
    type: "File",
    required: true,
    validator: null,
    locality: { type: "Auto" },
    durability: "Ephemeral",
    sizeHint: { type: "SizeClass", value: "Unknown" },
  },
};

interface StudioDraft {
  name: string;
  version: string;
  language: SandboxLanguage;
  runtimeProfileId: string;
  entrypoint: string;
  content: string;
  inputsText: string;
  outputsText: string;
  fixturesText: string;
  changelog: string;
}

function defaultDraft(): StudioDraft {
  return {
    name: "",
    version: "0.1.0",
    language: "python",
    runtimeProfileId: "",
    entrypoint: "main.py",
    content: CODE_TEMPLATES.python ?? "",
    inputsText: JSON.stringify(DEFAULT_INPUTS, null, 2),
    outputsText: JSON.stringify(DEFAULT_OUTPUTS, null, 2),
    fixturesText: "{}",
    changelog: "",
  };
}

function draftFromPayload(
  name: string,
  version: string,
  payload: SandboxScriptPayload,
): StudioDraft {
  return {
    name,
    version,
    language: payload.language,
    runtimeProfileId: payload.runtimeProfileId ?? "",
    entrypoint: payload.entrypoint,
    content: payload.content,
    inputsText: JSON.stringify(payload.inputs, null, 2),
    outputsText: JSON.stringify(payload.outputs, null, 2),
    fixturesText: "{}",
    changelog: "",
  };
}

function parseRecord<T>(value: string, label: string): Record<string, T> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, T>;
}

function entrypointFor(language: SandboxLanguage): string {
  if (language === "nodejs") return "main.mjs";
  if (language === "bash") return "main.sh";
  return "main.py";
}

export function SandboxScriptStudio({ scriptId }: { scriptId?: string }) {
  const { t, i18n } = useTranslation();
  const { canPublish } = useSoftwarePublishingAccess();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StudioDraft>(defaultDraft);
  const [plannerMode, setPlannerMode] = useState<PlannerMode>("Lookahead");
  const [mappingId, setMappingId] = useState("");
  const [promptSource, setPromptSource] = useState("");
  const [promptTarget, setPromptTarget] = useState("");
  const [promptUsecase, setPromptUsecase] = useState("");
  const [renderedPrompt, setRenderedPrompt] = useState("");
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const detailQuery = useQuery({
    queryKey: ["sandbox-script", scriptId],
    queryFn: () => getSandboxScript(scriptId ?? ""),
    enabled: scriptId !== undefined,
    retry: (failureCount, error) =>
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === "FORBIDDEN" &&
      failureCount < 3,
    retryDelay: (attempt) => Math.min(250 * 2 ** attempt, 1_000),
  });
  const runtimesQuery = useQuery({
    queryKey: ["sandbox-runtime-profiles"],
    queryFn: listSandboxRuntimeProfiles,
    retry: false,
  });

  useEffect(() => {
    const detail = detailQuery.data;
    const latest = detail?.revisions[0];
    if (!detail || !latest) return;
    setDraft(draftFromPayload(detail.asset.name, detail.asset.version, latest.payload));
    setSelectedRevision(latest.revision);
  }, [detailQuery.data]);

  useEffect(() => {
    if (scriptId || draft.runtimeProfileId !== "") return;
    const runtime = runtimesQuery.data?.find(
      (candidate) => candidate.lifecycle === "active" && candidate.language === draft.language,
    );
    if (runtime) setDraft((current) => ({ ...current, runtimeProfileId: runtime.id }));
  }, [draft.language, draft.runtimeProfileId, runtimesQuery.data, scriptId]);

  const activeRuntimes = useMemo(
    () =>
      (runtimesQuery.data ?? []).filter(
        (runtime) => runtime.lifecycle === "active" && runtime.language === draft.language,
      ),
    [draft.language, runtimesQuery.data],
  );
  const selectedRuntime = activeRuntimes.find((runtime) => runtime.id === draft.runtimeProfileId);
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (draft.name.trim() === "") errors.push(t("sandbox.studio.validation.name"));
    if (draft.runtimeProfileId === "") errors.push(t("sandbox.studio.validation.runtime"));
    if (!/^[a-zA-Z0-9._-]+$/.test(draft.entrypoint)) {
      errors.push(t("sandbox.studio.validation.entrypoint"));
    }
    if (draft.content.trim() === "") errors.push(t("sandbox.studio.validation.content"));
    try {
      const inputs = parseRecord<unknown>(draft.inputsText, t("sandbox.studio.inputs"));
      for (const spec of Object.values(inputs)) workflowDsl.ScriptInputSpecSchema.parse(spec);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const outputs = parseRecord<unknown>(draft.outputsText, t("sandbox.studio.outputs"));
      for (const spec of Object.values(outputs)) workflowDsl.ScriptOutputSpecSchema.parse(spec);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      parseRecord(draft.fixturesText, t("sandbox.studio.fixtures"));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return errors;
  }, [draft, t]);

  const writePayload = (): SandboxScriptWrite => ({
    name: draft.name.trim(),
    version: draft.version.trim(),
    language: draft.language,
    runtimeProfileId: draft.runtimeProfileId,
    entrypoint: draft.entrypoint.trim(),
    content: draft.content,
    inputs: parseRecord<ScriptInputSpec>(draft.inputsText, "inputs"),
    outputs: parseRecord<ScriptOutputSpec>(draft.outputsText, "outputs"),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (validation.length > 0) throw new Error(validation[0]);
      const payload = writePayload();
      if (!scriptId) return createSandboxScript(payload);
      return createSandboxScriptRevision(scriptId, {
        name: payload.name,
        version: payload.version,
        language: payload.language,
        runtimeProfileId: payload.runtimeProfileId,
        entrypoint: payload.entrypoint,
        content: payload.content,
        inputs: payload.inputs,
        outputs: payload.outputs,
        ...(draft.changelog.trim() ? { changelog: draft.changelog.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      toast.success(t("sandbox.studio.saved"));
      void queryClient.invalidateQueries({ queryKey: ["sandbox-scripts"] });
      if (!scriptId && "asset" in result) {
        queryClient.setQueryData(["sandbox-script", result.asset.id], {
          asset: result.asset,
          revisions: [result.revision],
          attestations: [],
        });
        void navigate({
          to: "/software/scripts/$scriptId",
          params: { scriptId: result.asset.id },
        });
      } else if (scriptId) {
        void queryClient.invalidateQueries({ queryKey: ["sandbox-script", scriptId] });
      }
    },
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!scriptId) throw new Error(t("sandbox.studio.deleteUnavailable"));
      return deleteSandboxScript(scriptId);
    },
    onSuccess: async () => {
      setDeleteOpen(false);
      toast.success(t("sandbox.studio.deleted"));
      await queryClient.invalidateQueries({ queryKey: ["sandbox-scripts"] });
      void navigate(softwareCatalogDestination("scripts"));
    },
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  const testMutation = useMutation({
    mutationFn: () => {
      if (!scriptId) throw new Error(t("sandbox.studio.saveBeforeTest"));
      const fixtures = parseRecord<unknown>(draft.fixturesText, "fixtures");
      return runSandboxScriptTest(scriptId, {
        fixtures,
        plannerMode,
        ...(mappingId.trim() ? { mappingId: mappingId.trim() } : {}),
      });
    },
    onSuccess: () => toast.success(t("sandbox.studio.testSubmitted")),
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  const promptMutation = useMutation({
    mutationFn: () => {
      if (!scriptId) throw new Error(t("sandbox.studio.saveBeforePrompt"));
      return renderSandboxPrompt(scriptId, {
        locale: i18n.language.startsWith("zh") ? "zh-CN" : "en-US",
        ...(promptSource.trim() ? { sourceApp: promptSource.trim() } : {}),
        ...(promptTarget.trim() ? { targetApp: promptTarget.trim() } : {}),
        ...(promptUsecase.trim() ? { usecase: promptUsecase.trim() } : {}),
      });
    },
    onSuccess: setRenderedPrompt,
    onError: (error) =>
      toast.error(toUserFacingError(error, t("software.governance.actionFailed"))),
  });

  const updateLanguage = (language: SandboxLanguage) => {
    const runtime = (runtimesQuery.data ?? []).find(
      (candidate) => candidate.lifecycle === "active" && candidate.language === language,
    );
    setDraft((current) => ({
      ...current,
      language,
      entrypoint: entrypointFor(language),
      content: CODE_TEMPLATES[language] ?? "",
      runtimeProfileId: runtime?.id ?? "",
    }));
  };

  const loadRevision = (revisionNumber: number) => {
    const detail = detailQuery.data;
    const revision = detail?.revisions.find((candidate) => candidate.revision === revisionNumber);
    if (!detail || !revision) return;
    setSelectedRevision(revision.revision);
    setDraft(draftFromPayload(detail.asset.name, detail.asset.version, revision.payload));
  };

  if (detailQuery.isLoading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
    );
  }
  if (detailQuery.error instanceof Error && !detailQuery.data) {
    return (
      <div className="text-sm text-[var(--status-failed)]">
        {toUserFacingError(detailQuery.error, t("software.unreachable"))}
      </div>
    );
  }

  return (
    <PageShell data-testid="sandbox-script-studio">
      <PageHeader
        title={scriptId ? draft.name || t("sandbox.studio.title") : t("sandbox.studio.createTitle")}
        subtitle={t("sandbox.studio.subtitle")}
        meta={
          <>
            <Badge variant="brand">Sandbox</Badge>
            {selectedRevision ? <Badge variant="outline">revision {selectedRevision}</Badge> : null}
            {detailQuery.data?.asset.lifecycle ? (
              <Badge variant="outline">{detailQuery.data.asset.lifecycle}</Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link {...softwareCatalogDestination("scripts")}>
                <ArrowLeft />
                {t("sandbox.studio.back")}
              </Link>
            </Button>
            {canPublish && scriptId && detailQuery.data?.asset.lifecycle === "draft" ? (
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 />
                {t("sandbox.studio.delete")}
              </Button>
            ) : null}
            {canPublish ? (
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || validation.length > 0}
              >
                <Save />
                {scriptId ? t("sandbox.studio.newRevision") : t("sandbox.studio.save")}
              </Button>
            ) : null}
          </>
        }
      />

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => !deleteMutation.isPending && setDeleteOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sandbox.studio.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("sandbox.studio.deleteDescription")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm leading-6">
              {t("sandbox.studio.deleteConfirm", { name: draft.name })}
            </p>
          </DialogBody>
          <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              <Trash2 />
              {deleteMutation.isPending
                ? t("sandbox.studio.deleting")
                : t("sandbox.studio.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[280px_minmax(420px,1fr)_340px]">
        <aside className="grid min-w-0 content-start gap-3">
          <StudioCard title={t("sandbox.studio.identity")}>
            <Field label={t("sandbox.studio.name")}>
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </Field>
            <Field label={t("sandbox.studio.version")}>
              <Input
                value={draft.version}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, version: event.target.value }))
                }
              />
            </Field>
            {detailQuery.data?.revisions.length ? (
              <Field label={t("sandbox.studio.revisions")}>
                <select
                  value={selectedRevision ?? ""}
                  onChange={(event) => loadRevision(Number(event.target.value))}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm"
                >
                  {detailQuery.data.revisions.map((revision) => (
                    <option key={revision.id} value={revision.revision}>
                      revision {revision.revision} · {revision.contentSha256?.slice(0, 10)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </StudioCard>
          <StudioCard title={t("sandbox.studio.ioManifest")}>
            <Field label={t("sandbox.studio.inputs")}>
              <Textarea
                rows={8}
                className="font-mono text-[11px]"
                value={draft.inputsText}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, inputsText: event.target.value }))
                }
              />
            </Field>
            <Field label={t("sandbox.studio.outputs")}>
              <Textarea
                rows={12}
                className="font-mono text-[11px]"
                value={draft.outputsText}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, outputsText: event.target.value }))
                }
              />
            </Field>
          </StudioCard>
        </aside>

        <main className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileCode2 className="h-4 w-4" />
              {draft.entrypoint}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{draft.language}</Badge>
              <span className="text-[11px] text-muted-foreground">UTF-8 · LF</span>
            </div>
          </div>
          <SandboxCodeEditor
            language={draft.language}
            value={draft.content}
            onChange={(content) => setDraft((current) => ({ ...current, content }))}
          />
          {scriptId ? (
            <Field label={t("sandbox.studio.changelog")} className="mt-3">
              <Input
                value={draft.changelog}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, changelog: event.target.value }))
                }
                placeholder={t("sandbox.studio.changelogPlaceholder")}
              />
            </Field>
          ) : null}
        </main>

        <aside className="grid min-w-0 content-start gap-3">
          <StudioCard title={t("sandbox.studio.runtime")}>
            <Field label={t("sandbox.studio.language")}>
              <select
                value={draft.language}
                onChange={(event) => updateLanguage(event.target.value as SandboxLanguage)}
                className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm"
              >
                <option value="python">Python</option>
                <option value="nodejs">Node.js</option>
                <option value="bash">Bash</option>
              </select>
            </Field>
            <Field label={t("sandbox.studio.runtimeProfile")}>
              <select
                value={draft.runtimeProfileId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, runtimeProfileId: event.target.value }))
                }
                className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm"
              >
                <option value="">{t("sandbox.studio.selectRuntime")}</option>
                {activeRuntimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.name} · {runtime.languageVersion}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("sandbox.studio.entrypoint")}>
              <Input
                value={draft.entrypoint}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, entrypoint: event.target.value }))
                }
              />
            </Field>
            {selectedRuntime ? (
              <div className="grid gap-2 rounded-md border border-border bg-background p-3 text-xs">
                <ManifestLine label="OCI" value={selectedRuntime.ociDigest ?? "—"} mono />
                <ManifestLine label="SIF" value={selectedRuntime.sifDigest ?? "—"} mono />
                <ManifestLine
                  label={t("sandbox.studio.adapters")}
                  value={selectedRuntime.adapters.join(", ")}
                />
                <ManifestLine
                  label={t("sandbox.studio.dependencies")}
                  value={
                    selectedRuntime.dependencies.length > 0
                      ? selectedRuntime.dependencies
                          .map((dependency) => `${dependency.name}@${dependency.version}`)
                          .join(", ")
                      : "—"
                  }
                />
              </div>
            ) : null}
          </StudioCard>
          <StudioCard title={t("sandbox.studio.security")}>
            <SecurityLine icon={<CloudOff />} text={t("sandbox.studio.noNetwork")} />
            <SecurityLine icon={<ShieldCheck />} text={t("sandbox.studio.readOnlyRoot")} />
            <SecurityLine icon={<Gauge />} text={t("sandbox.studio.policyLimits")} />
            <p className="text-[11px] leading-5 text-muted-foreground">
              {t("sandbox.studio.artifactOnly")}
            </p>
          </StudioCard>
        </aside>
      </div>

      <Card>
        <Tabs defaultValue="validation">
          <CardHeader className="pb-0">
            <TabsList className="flex h-auto flex-wrap">
              <TabsTrigger value="validation">{t("sandbox.studio.validationTab")}</TabsTrigger>
              <TabsTrigger value="test">{t("sandbox.studio.testTab")}</TabsTrigger>
              <TabsTrigger value="prompt">{t("sandbox.studio.promptTab")}</TabsTrigger>
              <TabsTrigger value="placement">{t("sandbox.studio.placementTab")}</TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent>
            <TabsContent value="validation">
              {validation.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-[var(--status-succeeded)]">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("sandbox.studio.validationPassed")}
                </div>
              ) : (
                <ul className="grid gap-1 text-sm text-[var(--status-failed)]">
                  {validation.map((error) => (
                    <li key={error}>• {error}</li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="test" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <Field label={t("sandbox.studio.fixtures")}>
                <Textarea
                  rows={10}
                  className="font-mono text-xs"
                  value={draft.fixturesText}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, fixturesText: event.target.value }))
                  }
                />
              </Field>
              <div className="grid content-start gap-3">
                <Field label={t("sandbox.studio.mappingId")}>
                  <Input
                    value={mappingId}
                    onChange={(event) => setMappingId(event.target.value)}
                    placeholder={t("sandbox.studio.mappingAuto")}
                  />
                </Field>
                <Button
                  onClick={() => testMutation.mutate()}
                  disabled={testMutation.isPending || !scriptId}
                >
                  <Play />
                  {t("sandbox.studio.runTest")}
                </Button>
                {testMutation.data ? (
                  <div className="rounded-md border border-border bg-background p-3 text-xs">
                    <div className="font-medium">{testMutation.data.status}</div>
                    <div className="mt-1 font-mono text-muted-foreground">
                      {testMutation.data.runId}
                    </div>
                    <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                      <Link to="/workflows/$runId" params={{ runId: testMutation.data.runId }}>
                        {t("sandbox.studio.openRun")}
                      </Link>
                    </Button>
                  </div>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="prompt" className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
              <div className="grid content-start gap-3">
                <Field label={t("sandbox.studio.sourceApp")}>
                  <Input
                    value={promptSource}
                    onChange={(event) => setPromptSource(event.target.value)}
                  />
                </Field>
                <Field label={t("sandbox.studio.targetApp")}>
                  <Input
                    value={promptTarget}
                    onChange={(event) => setPromptTarget(event.target.value)}
                  />
                </Field>
                <Field label={t("sandbox.studio.usecase")}>
                  <Input
                    value={promptUsecase}
                    onChange={(event) => setPromptUsecase(event.target.value)}
                  />
                </Field>
                <Button
                  variant="outline"
                  onClick={() => promptMutation.mutate()}
                  disabled={!scriptId || promptMutation.isPending}
                >
                  <FlaskConical />
                  {t("sandbox.studio.renderPrompt")}
                </Button>
              </div>
              <div className="relative">
                <Textarea
                  readOnly
                  rows={13}
                  className="font-mono text-xs"
                  value={renderedPrompt}
                  placeholder={t("sandbox.studio.promptPlaceholder")}
                />
                {renderedPrompt ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="absolute right-2 top-2"
                    onClick={() => {
                      void navigator.clipboard.writeText(renderedPrompt).then(
                        () => toast.success(t("sandbox.studio.copied")),
                        () => toast.error(t("sandbox.studio.copyFailed")),
                      );
                    }}
                  >
                    <Clipboard />
                    {t("sandbox.studio.copy")}
                  </Button>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="placement" className="grid gap-3 md:grid-cols-3">
              <Field label={t("sandbox.studio.plannerMode")}>
                <select
                  value={plannerMode}
                  onChange={(event) => setPlannerMode(event.target.value as PlannerMode)}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="Global">Global</option>
                  <option value="Lookahead">Lookahead</option>
                  <option value="Greedy">Greedy</option>
                </select>
              </Field>
              <PreviewMetric
                label={t("sandbox.studio.identityMode")}
                value={mappingId.trim() ? "MappedAccount" : "MappedAuto"}
              />
              <PreviewMetric
                label={t("sandbox.studio.localityPreview")}
                value={t("sandbox.studio.runtimePlacement")}
              />
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>
    </PageShell>
  );
}

function StudioCard({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Card>
      <CardHeader className="pb-2 text-sm font-semibold">{title}</CardHeader>
      <CardContent className="grid gap-3">{children}</CardContent>
    </Card>
  );
}

function Field({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <fieldset className={`grid gap-1 text-xs text-muted-foreground ${className ?? ""}`}>
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

function ManifestLine({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`mt-0.5 break-all text-foreground ${mono ? "font-mono text-[10px]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function SecurityLine({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--status-succeeded)] [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}
