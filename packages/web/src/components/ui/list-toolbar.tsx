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
    <div className="flex min-w-0 flex-wrap items-start gap-3">
      <div className="kq-fill-row flex-[4_1_32rem]">
        <SearchInput containerClassName="basis-full sm:basis-64" {...search} />
        {children}
      </div>
      {actions ? <div className="kq-fill-row flex-[1_1_auto]">{actions}</div> : null}
    </div>
  );
}
