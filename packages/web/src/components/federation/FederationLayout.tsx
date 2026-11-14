import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function FederationPanelHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="federation-toolbar">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}

export function FederationEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="federation-empty" role="status">
      <Inbox aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
