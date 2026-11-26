import { useCallback, useState } from "react";

export function useCompactLayout(minWideWidth: number) {
  const [compact, setCompact] = useState(false);
  const measure = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const update = (width: number) => {
        if (width > 0) setCompact(width < minWideWidth);
      };
      update(element.clientWidth);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) update(entry.contentRect.width);
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    [minWideWidth],
  );
  return [measure, compact] as const;
}
