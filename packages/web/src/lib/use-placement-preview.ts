import type { JobSubmit, PlacementTrace } from "@kuintessence/shared/browser";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ApiError, api } from "./api-client";

/**
 * placement-preview hook.
 *
 * Wraps a TanStack Query mutation around `POST /platform/api/scheduler/preview-placement`.
 * The Web "Placement preview" panel calls `refresh(jobSpec)` whenever the user
 * wants to see how their draft job would route through the placement
 * pipeline. The hook keeps the latest trace in local state so the stepper UI
 * keeps showing the previous answer while a new preview is in flight, which
 * is what the user expects when they tweak a value and re-click "Refresh".
 *
 * Returns:
 *   - trace: the most recent successful preview, or null
 *   - isLoading: true while a preview request is in flight
 *   - error: the most recent ApiError or generic Error, or null
 *   - refresh(jobSpec): kick off a new preview request
 */
export interface UsePlacementPreviewResult {
  trace: PlacementTrace | null;
  isLoading: boolean;
  error: ApiError | Error | null;
  refresh: (job: JobSubmit) => Promise<PlacementTrace>;
  reset: () => void;
}

export function usePlacementPreview(): UsePlacementPreviewResult {
  const [trace, setTrace] = useState<PlacementTrace | null>(null);
  const mutation = useMutation<PlacementTrace, Error, JobSubmit>({
    mutationFn: (job) => api.post<PlacementTrace>("/scheduler/preview-placement", job),
    onSuccess: (data) => setTrace(data),
  });

  const refresh = useCallback(
    async (job: JobSubmit) => mutation.mutateAsync(job),
    [mutation.mutateAsync],
  );

  const reset = useCallback(() => {
    setTrace(null);
    mutation.reset();
  }, [mutation.reset]);

  return {
    trace,
    isLoading: mutation.isPending,
    error: mutation.error ?? null,
    refresh,
    reset,
  };
}
