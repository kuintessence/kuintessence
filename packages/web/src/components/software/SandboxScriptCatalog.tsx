import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Braces, Code2, FileCode2, PackagePlus, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSandboxScripts } from "../../lib/sandbox-client";
import { useSoftwarePublishingAccess } from "../../lib/software-publishing-access";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Input } from "../ui/input";
import { PageHeader, PageShell } from "../ui/page";
import { CatalogEmptyState } from "./CatalogEmptyState";
import {
  cardActionLayerClass,
  cardContentLayerClass,
  cardSurfaceLinkClass,
  clickableCardClass,
} from "./card-navigation";

type LanguageFilter = "all" | "python" | "nodejs" | "bash";

function languageIcon(language: string) {
  if (language === "bash") return <FileCode2 className="h-4 w-4" />;
  if (language === "nodejs") return <Braces className="h-4 w-4" />;
  return <Code2 className="h-4 w-4" />;
}

export function SandboxScriptCatalog({
  embedded = false,
  onCountsChange,
}: {
  embedded?: boolean;
  onCountsChange?: (counts: { total: number; visible: number }) => void;
}) {
  const { t } = useTranslation();
  const { canPublish } = useSoftwarePublishingAccess();
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState<LanguageFilter>("all");
  const scriptsQuery = useQuery({
    queryKey: ["sandbox-scripts"],
    queryFn: listSandboxScripts,
    refetchInterval: 30_000,
    retry: false,
  });
  const scripts = scriptsQuery.data ?? [];
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scripts.filter((script) => {
      const matchesLanguage = language === "all" || script.payload.language === language;
      const haystack = [
        script.name,
        script.version,
        script.payload.language,
        script.payload.entrypoint,
        script.lifecycle,
        script.visibility,
        ...Object.keys(script.payload.inputs),
        ...Object.keys(script.payload.outputs),
      ]
        .join(" ")
        .toLowerCase();
      return matchesLanguage && (query === "" || haystack.includes(query));
    });
  }, [language, scripts, search]);

  useEffect(() => {
    onCountsChange?.({ total: scripts.length, visible: visible.length });
  }, [onCountsChange, scripts.length, visible.length]);

  return (
    <PageShell data-testid="sandbox-script-catalog" data-embedded={embedded ? "true" : "false"}>
      {embedded ? null : (
        <PageHeader
          title={t("sandbox.catalog.title")}
          subtitle={t("sandbox.catalog.subtitle")}
          meta={
            <Badge variant="brand">
              <ShieldCheck className="h-3 w-3" />
              {t("sandbox.catalog.governed")}
            </Badge>
          }
          actions={
            <>
              <span className="rounded-md border border-border px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                {visible.length} / {scripts.length}
              </span>
              {canPublish ? (
                <Button asChild size="sm">
                  <Link to="/software/scripts/new">
                    <PackagePlus />
                    {t("sandbox.catalog.create")}
                  </Link>
                </Button>
              ) : null}
            </>
          }
        />
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[minmax(0,1fr)_220px]">
        <label htmlFor="sandbox-script-search" className="grid gap-1 text-xs text-muted-foreground">
          <span>{t("sandbox.catalog.search")}</span>
          <span className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4" />
            <Input
              id="sandbox-script-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder={t("sandbox.catalog.searchPlaceholder")}
            />
          </span>
        </label>
        <label
          htmlFor="sandbox-language-filter"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          <span>{t("sandbox.catalog.language")}</span>
          <select
            id="sandbox-language-filter"
            value={language}
            onChange={(event) => setLanguage(event.target.value as LanguageFilter)}
            className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm"
          >
            <option value="all">{t("sandbox.catalog.allLanguages")}</option>
            <option value="python">Python</option>
            <option value="nodejs">Node.js</option>
            <option value="bash">Bash</option>
          </select>
        </label>
      </div>

      {scriptsQuery.isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : scriptsQuery.error instanceof Error ? (
        <div className="rounded-md border border-status-failed/40 p-4 text-sm text-[var(--status-failed)]">
          {toUserFacingError(scriptsQuery.error, t("software.unreachable"))}
        </div>
      ) : scripts.length === 0 ? (
        <CatalogEmptyState
          actionLabel={t("sandbox.catalog.create")}
          actionTo="/software/scripts/new"
          description={t("sandbox.catalog.emptyLibraryHint")}
          icon={<Code2 />}
          showAction={canPublish}
          testId="sandbox-script-empty"
          title={t("sandbox.catalog.emptyLibraryTitle")}
        />
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center">
          <Code2 className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">{t("sandbox.catalog.empty")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("sandbox.catalog.emptyHint")}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visible.map((script) => (
            <Card
              key={script.id}
              className={`flex min-w-0 flex-col ${clickableCardClass}`}
              data-testid={`sandbox-script-card-${script.id}`}
            >
              <Link
                to="/software/scripts/$scriptId"
                params={{ scriptId: script.id }}
                className={cardSurfaceLinkClass}
                aria-label={`${t("sandbox.catalog.open")}: ${script.name}`}
                data-testid={`sandbox-script-card-surface-${script.id}`}
              />
              <CardHeader
                className={`flex flex-row items-start justify-between gap-3 space-y-0 ${cardContentLayerClass}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {languageIcon(script.payload.language)}
                    <h2 className="truncate text-sm font-semibold">{script.name}</h2>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {script.payload.entrypoint}
                  </p>
                </div>
                <Badge variant="outline">v{script.version}</Badge>
              </CardHeader>
              <CardContent
                className={`flex flex-1 flex-col gap-3 text-xs ${cardContentLayerClass}`}
              >
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="brand">{script.payload.language}</Badge>
                  <Badge variant="outline">{script.lifecycle}</Badge>
                  <Badge variant="outline">{script.visibility}</Badge>
                  {script.sharedAccountEligible ? (
                    <Badge variant="succeeded">{t("sandbox.catalog.sharedEligible")}</Badge>
                  ) : (
                    <Badge variant="pending">{t("sandbox.catalog.mappedOnly")}</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border bg-background p-2">
                    <div className="text-muted-foreground">{t("sandbox.catalog.inputs")}</div>
                    <div className="mt-1 font-mono tabular-nums">
                      {Object.keys(script.payload.inputs).length}
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-background p-2">
                    <div className="text-muted-foreground">{t("sandbox.catalog.outputs")}</div>
                    <div className="mt-1 font-mono tabular-nums">
                      {Object.keys(script.payload.outputs).length}
                    </div>
                  </div>
                </div>
                <div className={`mt-auto flex justify-end pt-1 ${cardActionLayerClass}`}>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/software/scripts/$scriptId" params={{ scriptId: script.id }}>
                      {t("sandbox.catalog.open")}
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  );
}
