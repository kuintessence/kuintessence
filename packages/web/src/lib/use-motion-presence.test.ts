import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useMotionPresence } from "./use-motion-presence";

const variable = "--kq-motion-fast";
let media: MediaQueryList;

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty(variable, "100ms");
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(variable);
});

test("keeps the closing snapshot only for the shared exit duration", () => {
  const { result, rerender } = renderHook(
    ({ value }: { value: string | null }) => useMotionPresence(value, variable),
    { initialProps: { value: "first" as string | null } },
  );
  rerender({ value: null });
  expect(result.current).toEqual({ present: true, snapshot: "first", state: "closed" });
  act(() => vi.advanceTimersByTime(100));
  expect(result.current.present).toBe(false);
  expect(result.current.snapshot).toBeNull();
});

test("zero duration removes the snapshot without a timeout", () => {
  document.documentElement.style.setProperty(variable, "0ms");
  const { result, rerender } = renderHook(
    ({ value }: { value: string | null }) => useMotionPresence(value, variable),
    { initialProps: { value: "first" as string | null } },
  );
  rerender({ value: null });
  expect(result.current.present).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("switching to reduced motion settles an ongoing exit immediately", () => {
  const { result, rerender } = renderHook(
    ({ value }: { value: string | null }) => useMotionPresence(value, variable),
    { initialProps: { value: "first" as string | null } },
  );
  rerender({ value: null });
  act(() => {
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    media.dispatchEvent(new Event("change"));
  });
  expect(result.current.present).toBe(false);
  expect(result.current.snapshot).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("a stale exit cannot remove a reopened target and unmount clears timers", () => {
  const { result, rerender, unmount } = renderHook(
    ({ value }: { value: string | null }) => useMotionPresence(value, variable),
    { initialProps: { value: "first" as string | null } },
  );
  rerender({ value: null });
  act(() => vi.advanceTimersByTime(50));
  rerender({ value: "second" });
  act(() => vi.advanceTimersByTime(200));
  expect(result.current).toEqual({ present: true, snapshot: "second", state: "open" });
  rerender({ value: null });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
