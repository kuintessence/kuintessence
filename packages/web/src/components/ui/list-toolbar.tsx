import type { ComponentProps, ReactNode } from "react";
import { SearchInput } from "./search-input";

export function ListToolbar({
  search,
  children,
  actions,
}: {
  search: ComponentProps<typeof SearchInput> & { "data-testid"?: string };
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <SearchInput containerClassName="w-full sm:max-w-80" {...search} />
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
