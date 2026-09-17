import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function readMatches(query: string): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") return window.matchMedia(query).matches;
  const maxWidth = query.match(/max-width:\s*(\d+)px/);
  if (maxWidth?.[1]) return window.innerWidth <= Number.parseInt(maxWidth[1], 10);
  return false;
}
