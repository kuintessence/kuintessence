import { Check, ChevronDown, Plus, ShieldCheck, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { statusLabel } from "../../lib/format";
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
import { ListToolbar } from "../ui/list-toolbar";
import { NativeSelect } from "../ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
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
  const { t, i18n } = useTranslation();
  return (
    <ListToolbar
      search={{
        value: search,
        onChange: (e) => onSearchChange(e.target.value),
        placeholder: t("jobs.searchPlaceholder"),
        "aria-label": t("jobs.searchPlaceholder"),
        "data-testid": "jobs-search",
      }}
      actions={
        <>
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
        </>
      }
    >
      <NativeSelect
        className="max-w-full sm:hidden"
        aria-label={t("dashboard.status")}
        value={status}
        onChange={(event) => onStatusChange(event.target.value as StatusFilter)}
        data-testid="jobs-status-select"
      >
        {STATUS_FILTERS.map((s) => (
          <option key={s} value={s}>
            {s === "ALL"
              ? t("common.all")
              : statusLabel(s, i18n?.resolvedLanguage ?? i18n?.language)}
          </option>
        ))}
      </NativeSelect>
      <ToggleGroup
        type="single"
        role="radiogroup"
        value={status}
        onValueChange={(value) => {
          if (value) onStatusChange(value as StatusFilter);
        }}
        className="hidden sm:flex"
        aria-label={t("dashboard.status")}
        data-testid="jobs-status-filter"
      >
        {STATUS_FILTERS.map((s) => (
          <ToggleGroupItem
            key={s}
            value={s}
            data-testid={`status-chip-${s.toLowerCase()}`}
            className="px-2.5 text-xs"
          >
            {s === "ALL"
              ? t("common.all")
              : statusLabel(s, i18n?.resolvedLanguage ?? i18n?.language)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9" data-testid="jobs-scope-filter">
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
    </ListToolbar>
  );
}
