import { PackageCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SoftwareOperationAction } from "../../lib/cp-client";
import { Button } from "../ui/button";
import { SearchInput } from "../ui/search-input";
import { policyRejectionMessage } from "./SoftwareOperations";

const COLLAPSED_SPEC_LIST_LIMIT = 60;

export function SpecList({
  specs,
  empty,
  onLoad,
  onUninstall,
  actionRejection,
  disabled,
}: {
  specs: string[];
  empty: string;
  onLoad?: (spec: string) => void;
  onUninstall?: (spec: string) => void;
  actionRejection?: (action: SoftwareOperationAction, spec: string) => string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");

  if (specs.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>;
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredSpecs =
    normalizedFilter.length === 0
      ? specs
      : specs.filter((spec) => spec.toLowerCase().includes(normalizedFilter));
  const visibleSpecs = expanded ? filteredSpecs : filteredSpecs.slice(0, COLLAPSED_SPEC_LIST_LIMIT);
  const hasHiddenSpecs = filteredSpecs.length > COLLAPSED_SPEC_LIST_LIMIT;
  const showFilter = specs.length > COLLAPSED_SPEC_LIST_LIMIT;
  return (
    <div className="grid gap-2">
      {showFilter ? (
        <SearchInput
          aria-label={t("cp.software.agent.installedFilterPlaceholder")}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setExpanded(false);
          }}
          placeholder={t("cp.software.agent.installedFilterPlaceholder")}
          className="h-9 font-mono text-xs"
          data-testid="cp-software-installed-filter"
        />
      ) : null}
      {visibleSpecs.length > 0 ? (
        visibleSpecs.map((spec) => {
          const loadRejection = onLoad ? (actionRejection?.("load", spec) ?? null) : null;
          const uninstallRejection = onUninstall
            ? (actionRejection?.("uninstall", spec) ?? null)
            : null;
          return (
            <div
              key={spec}
              className="grid gap-2 border-border p-2 text-xs md:grid-cols-[1fr_auto]"
            >
              <code className="min-w-0 truncate px-2 py-1 font-mono" title={spec}>
                {spec}
              </code>
              {onLoad || onUninstall ? (
                <div className="flex gap-1">
                  {onLoad ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onLoad(spec)}
                      disabled={disabled || Boolean(loadRejection)}
                      title={
                        loadRejection
                          ? policyRejectionMessage(loadRejection, t)
                          : t("cp.software.operations.action.load")
                      }
                      data-testid={`cp-software-installed-load-${spec}`}
                    >
                      <PackageCheck />
                    </Button>
                  ) : null}
                  {onUninstall ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onUninstall(spec)}
                      disabled={disabled || Boolean(uninstallRejection)}
                      title={
                        uninstallRejection
                          ? policyRejectionMessage(uninstallRejection, t)
                          : t("cp.software.operations.action.uninstall")
                      }
                      data-testid={`cp-software-installed-uninstall-${spec}`}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="flex h-20 items-center justify-center border-border text-sm text-muted-foreground">
          {t("cp.software.agent.installedFilterEmpty")}
        </div>
      )}
      {hasHiddenSpecs ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t("cp.software.agent.installedCountHint", {
              visible: visibleSpecs.length,
              total: filteredSpecs.length,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t("cp.software.agent.installedShowLess", { count: COLLAPSED_SPEC_LIST_LIMIT })
              : t("cp.software.agent.installedShowAll", { count: specs.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
