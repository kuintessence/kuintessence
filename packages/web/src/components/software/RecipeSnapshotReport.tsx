import type { RecipeSnapshot } from "@kuintessence/shared/browser";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

export function RecipeSnapshotReport({ snapshot }: { snapshot: RecipeSnapshot }) {
  const { t } = useTranslation();
  const diagnostics = new Map(
    snapshot.diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic]),
  );
  return (
    <div className="min-w-0 space-y-3 border-border pt-3 text-xs">
      <h4 className="font-medium">{t("recipes.diagnostics")}</h4>
      <code className="block break-all">{snapshot.commit}</code>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{t("recipes.staticOnly")}</Badge>
        <span>
          {t("recipes.filesAndBytes", { files: snapshot.fileCount, bytes: snapshot.totalBytes })}
        </span>
      </div>
      <p className="break-all">
        {t("recipes.bundleSha")}: {snapshot.bundleSha256}
      </p>
      <h4 className="font-medium">{t("recipes.roots")}</h4>
      <div className="overflow-x-auto">
        <Table className="w-full text-left" aria-label={t("recipes.roots")}>
          <TableHeader className="border-b border-border text-muted-foreground">
            <TableRow>
              {["path", "namespaceLabel", "api", "packages"].map((key) => (
                <TableHead key={key} className="p-2 font-medium">
                  {t(`recipes.${key}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.roots.map((root) => (
              <TableRow key={root.path} className="border-b border-border">
                <TableCell className="break-all p-2">{root.path}</TableCell>
                <TableCell className="break-all p-2">{root.namespace}</TableCell>
                <TableCell className="p-2">{root.api}</TableCell>
                <TableCell className="p-2">{root.packageCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {snapshot.diagnostics.length === 0 ? (
        <p>{t("recipes.noDiagnostics")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {[...diagnostics].map(([key, diagnostic]) => (
            <li key={key} className="space-y-1 break-all py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={diagnostic.severity === "error" ? "failed" : "outline"}>
                  {t(`recipes.${diagnostic.severity}`)}
                </Badge>
                <code>{diagnostic.code}</code>
                {diagnostic.package ? <span>{diagnostic.package}</span> : null}
              </div>
              <p>{diagnostic.message}</p>
              {diagnostic.path ? <code className="block">{diagnostic.path}</code> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
