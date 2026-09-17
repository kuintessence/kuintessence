import { Check, ChevronDown, Plus, Search, ShieldCheck, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import {
  ACCESS_SCOPE_FILTERS,
  type AccessScopeFilter,
  STATUS_FILTERS,
  type StatusFilter,
} from "./types";

export interface JobsToolbarProps {
  search: string;
  onSearchChange: (next: string) => void;
  status: StatusFilter;
  onStatusChange: (next: StatusFilter) => void;
  scope: AccessScopeFilter;
  onScopeChange: (next: AccessScopeFilter) => void;
  onSubmitJob: () => void;
  onImportJson: () => void;
  onCreateFromUsecase: () => void;
  actionsDisabled?: boolean;
}

export function JobsToolbar({
  search,
  onSearchChange,
  status,
  onStatusChange,
  scope,
  onScopeChange,
  onSubmitJob,
  onImportJson,
  onCreateFromUsecase,
  actionsDisabled = false,
}: JobsToolbarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-80">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("jobs.searchPlaceholder")}
            className="pl-8"
            data-testid="jobs-search"
          />
        </div>
        <div className="flex flex-wrap gap-1" data-testid="jobs-status-filter">
          {STATUS_FILTERS.map((s) => {
            const active = s === status;
            return (
              <button
                key={s}
                type="button"
                data-testid={`status-chip-${s.toLowerCase()}`}
                onClick={() => onStatusChange(s)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  active
                    ? "border-brand bg-brand-soft text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60",
                )}
              >
                {s === "ALL" ? t("common.all") : s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            );
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="jobs-scope-filter">
              <ShieldCheck className="h-4 w-4" />
              {t(`jobs.scope.${scope}`)}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("jobs.scope.label")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ACCESS_SCOPE_FILTERS.map((option) => (
              <DropdownMenuItem
                key={option}
                onSelect={() => onScopeChange(option)}
                data-testid={`jobs-scope-${option}`}
              >
                <Check className={cn("h-4 w-4", option !== scope && "opacity-0")} />
                {t(`jobs.scope.${option}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          className="min-w-0"
          onClick={onSubmitJob}
          disabled={actionsDisabled}
          data-testid="jobs-submit-button"
        >
          <Plus />
          {t("jobs.submitJob")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              disabled={actionsDisabled}
              data-testid="jobs-submit-menu"
              aria-label={t("jobs.moreOptions")}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("jobs.moreOptions")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onImportJson} data-testid="jobs-submit-upload">
              <Upload />
              {t("jobs.uploadJson")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCreateFromUsecase} data-testid="jobs-submit-template">
              {t("jobs.fromTemplate")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
