import {
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  type SpackMaterialManifest,
} from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSpackMaterial } from "../../lib/spack-materials-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PAGE_SIZE = 20;

export function MaterialReleaseLookup({
  initialBinding,
  isCurrent,
}: {
  initialBinding?: SpackMaterialBinding;
  isCurrent: () => boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [repositoryId, setRepositoryId] = useState(initialBinding?.repositoryId ?? "");
  const [manifestDigest, setManifestDigest] = useState(initialBinding?.manifestDigest ?? "");
  const [manifest, setManifest] = useState<SpackMaterialManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const latestCurrent = useRef(isCurrent);
  latestCurrent.current = isCurrent;
  const translate = useRef(t);
  translate.current = t;
  const valid = SpackMaterialBindingSchema.safeParse({ repositoryId, manifestDigest }).success;

  const lookup = useCallback(async (binding: SpackMaterialBinding) => {
    if (!mounted.current || !latestCurrent.current()) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setManifest(null);
    setError(null);
    setPage(0);
    try {
      const result = await getSpackMaterial(binding, controller.signal);
      if (mounted.current && latestCurrent.current() && !controller.signal.aborted)
        setManifest(result);
    } catch (failure) {
      if (mounted.current && latestCurrent.current() && !controller.signal.aborted) {
        setError(toUserFacingError(failure, translate.current("materials.lookupFailed")));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current && latestCurrent.current()) setLoading(false);
      }
    }
  }, []);

  // Each selected binding receives a keyed component so old responses cannot replace it.
  useEffect(() => {
    mounted.current = true;
    if (initialBinding) void lookup(initialBinding);
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, [initialBinding, lookup]);

  function resetResult() {
    active.current?.abort();
    active.current = null;
    setLoading(false);
    setManifest(null);
    setError(null);
  }

  return (
    <div className="min-w-0 space-y-3 py-2">
      <h3 className="text-xs font-medium">{t("materials.lookupTitle")}</h3>
      <form
        className="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void lookup({ repositoryId, manifestDigest });
        }}
      >
        <label htmlFor={`${id}-repository`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.repositoryId")}</span>
          <Input
            id={`${id}-repository`}
            className="font-mono"
            value={repositoryId}
            onChange={(event) => {
              resetResult();
              setRepositoryId(event.target.value);
            }}
          />
        </label>
        <label htmlFor={`${id}-digest`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.manifestDigest")}</span>
          <Input
            id={`${id}-digest`}
            className="font-mono"
            value={manifestDigest}
            onChange={(event) => {
              resetResult();
              setManifestDigest(event.target.value);
            }}
          />
        </label>
        <Button
          type="submit"
          size="icon"
          variant="outline"
          disabled={!valid || loading}
          title={t("materials.lookup")}
          aria-label={t("materials.lookup")}
        >
          {loading ? <Loader2 className="animate-spin" /> : <Search />}
        </Button>
      </form>
      {loading ? (
        <p role="status" className="text-xs">
          {t("materials.loading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-status-failed">
          {error}
        </p>
      ) : null}
      {manifest ? (
        <div className="min-w-0 space-y-3" data-testid="material-release-detail">
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
            {[
              [t("materials.repository"), manifest.repository],
              [t("materials.release"), manifest.spec],
              [t("materials.target"), manifest.target],
              ["Spack", manifest.spackVersion],
              [t("materials.lockfile"), manifest.lockfile.digest],
              [t("materials.redistributionLabel"), manifest.redistribution],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="divide-y divide-border text-xs" aria-label={t("materials.recipes")}>
            {[...new Map(manifest.recipes.map((recipe) => [JSON.stringify(recipe), recipe]))].map(
              ([key, recipe]) => (
                <li key={key} className="space-y-1 break-all py-2 font-mono">
                  <div>{recipe.repositoryId}</div>
                  <div>{recipe.commit}</div>
                  <div>{recipe.roots.join(", ")}</div>
                </li>
              ),
            )}
          </ul>
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[32rem] table-fixed text-left text-xs"
              aria-label={t("materials.sourceFiles")}
            >
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="w-[35%] p-2 font-medium">{t("materials.path")}</th>
                  <th className="p-2 font-medium">SHA-256</th>
                  <th className="w-24 p-2 font-medium">{t("materials.bytes")}</th>
                </tr>
              </thead>
              <tbody>
                {manifest.sources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((source) => (
                  <tr key={source.path} className="border-b border-border">
                    <td className="break-all p-2 align-top font-mono">{source.path}</td>
                    <td className="break-all p-2 align-top font-mono">{source.blob.digest}</td>
                    <td className="break-all p-2 align-top">{source.blob.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 text-xs">
            <span>
              {page + 1} / {Math.ceil(manifest.sources.length / PAGE_SIZE)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              disabled={page === 0}
              title={t("materials.previous")}
              aria-label={t("materials.previous")}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={(page + 1) * PAGE_SIZE >= manifest.sources.length}
              title={t("materials.next")}
              aria-label={t("materials.next")}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
