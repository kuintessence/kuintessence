import type { ReactNode } from "react";

export function FormHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium">
      <span className="[&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground">{icon}</span>
      {title}
    </div>
  );
}
