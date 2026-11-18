import type { ReactNode } from "react";

export function SmallEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 border-border text-sm text-muted-foreground">
      <span className="[&_svg]:h-5 [&_svg]:w-5">{icon}</span>
      {text}
    </div>
  );
}
