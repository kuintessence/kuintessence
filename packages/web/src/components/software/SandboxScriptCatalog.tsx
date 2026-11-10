import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Braces, Code2, FileCode2, PackagePlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSandboxScripts } from "../../lib/sandbox-client";
import { useSoftwarePublishingAccess } from "../../lib/software-publishing-access";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { EmptyState, ErrorState, LoadingState } from "../ui/content-state";
import { NativeSelect } from "../ui/native-select";
import { PageHeader, PageShell } from "../ui/page";
import { SearchInput } from "../ui/search-input";
import { CatalogEmptyState } from "./CatalogEmptyState";
import {
  cardActionLayerClass,
  cardContentLayerClass,
  cardSurfaceLinkClass,
  clickableCardClass,
} from "./card-navigation";
import { SoftwareCardGrid } from "./SoftwareCardGrid";

type LanguageFilter = "all" | "python" | "nodejs" | "bash";

function languageIcon(language: string) {
  if (language === "bash") return <FileCode2 className="h-4 w-4" />;
  if (language === "nodejs") return <Braces className="h-4 w-4" />;
  return <Code2 className="h-4 w-4" />;
}

export function SandboxScriptCatalog({ embedded = false }: { embedded?: boolean }) {
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

  return (
    <PageShell data-testid="sandbox-script-catalog" data-embedded={embedded ? "true" : "false"}>
      {embedded ? null : (
        <PageHeader
          title={t("sandbox.catalog.title")}
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

      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label htmlFor="sandbox-script-search" className="grid gap-1 text-xs text-muted-foreground">
          <span>{t("sandbox.catalog.search")}</span>
          <SearchInput
            id="sandbox-script-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("sandbox.catalog.searchPlaceholder")}
          />
        </label>
        <label
          htmlFor="sandbox-language-filter"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          <span>{t("sandbox.catalog.language")}</span>
          <NativeSelect
            id="sandbox-language-filter"
            value={language}
            onChange={(event) => setLanguage(event.target.value as LanguageFilter)}
          >
            <option value="all">{t("sandbox.catalog.allLanguages")}</option>
            <option value="python">Python</option>
            <option value="nodejs">Node.js</option>
            <option value="bash">Bash</option>
          </NativeSelect>
        </label>
      </div>

      {scriptsQuery.isLoading ? (
        <LoadingState>{t("common.loading")}</LoadingState>
      ) : scriptsQuery.error instanceof Error ? (
        <ErrorState>{toUserFacingError(scriptsQuery.error, t("software.unreachable"))}</ErrorState>
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
        <EmptyState
          icon={<Code2 />}
          title={t("sandbox.catalog.empty")}
          description={t("sandbox.catalog.emptyHint")}
        />
      ) : (
        <SoftwareCardGrid className="gap-4">
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
                  <div className="flex items-start gap-2 [&>svg]:mt-0.5 [&>svg]:shrink-0">
                    {languageIcon(script.payload.language)}
                    <h2 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
                      {script.name}
                    </h2>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {script.payload.entrypoint}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0">
                  v{script.version}
                </Badge>
              </CardHeader>
              <CardContent
                className={`flex flex-1 flex-col gap-3 text-xs ${cardContentLayerClass}`}
              >
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="brand">{script.payload.language}</Badge>
                  <Badge variant="outline">
                    {t(`software.governance.lifecycle.${script.lifecycle}`, {
                      defaultValue: script.lifecycle,
                    })}
                  </Badge>
                  <Badge variant="outline">
                    {t(`software.governance.visibility.${script.visibility}`, {
                      defaultValue: script.visibility,
                    })}
                  </Badge>
                  {script.sharedAccountEligible ? (
                    <Badge variant="succeeded">{t("sandbox.catalog.sharedEligible")}</Badge>
                  ) : (
                    <Badge variant="pending">{t("sandbox.catalog.mappedOnly")}</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-baseline gap-2">
                    <div className="text-muted-foreground">{t("sandbox.catalog.inputs")}</div>
                    <div className="tabular-nums">{Object.keys(script.payload.inputs).length}</div>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <div className="text-muted-foreground">{t("sandbox.catalog.outputs")}</div>
                    <div className="tabular-nums">{Object.keys(script.payload.outputs).length}</div>
                  </div>
                </div>
                <div className={`mt-auto kq-fill-row pt-1 ${cardActionLayerClass}`}>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/software/scripts/$scriptId" params={{ scriptId: script.id }}>
                      {t("sandbox.catalog.open")}
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </SoftwareCardGrid>
      )}
    </PageShell>
  );
}
