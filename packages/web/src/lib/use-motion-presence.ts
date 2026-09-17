import { useEffect, useRef, useState } from "react";

type MotionState = "open" | "closed";

function durationFor(variable: string): number {
  if (typeof window === "undefined") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value);
  if (value.endsWith("s")) return Number.parseFloat(value) * 1_000;
  return 0;
}

export function useMotionPresence<T>(value: T | null, durationVariable: string) {
  const [snapshot, setSnapshot] = useState<T | null>(value);
  const [state, setState] = useState<MotionState>(value === null ? "closed" : "open");
  const [present, setPresent] = useState(value !== null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const clearExit = () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
    clearExit();
    if (value !== null) {
      setSnapshot(value);
      setPresent(true);
      setState("open");
      return clearExit;
    }
    if (!present) return clearExit;
    setState("closed");
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finishExit = () => {
      clearExit();
      setPresent(false);
      setSnapshot(null);
    };
    const duration = durationFor(durationVariable);
    if (media.matches || duration <= 0) {
      finishExit();
      return clearExit;
    }
    const onMotionChange = () => {
      if (media.matches) finishExit();
    };
    media.addEventListener("change", onMotionChange);
    timeoutRef.current = window.setTimeout(finishExit, duration);
    return () => {
      clearExit();
      media.removeEventListener("change", onMotionChange);
    };
  }, [durationVariable, present, value]);

  return { present, snapshot, state };
}
