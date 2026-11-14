import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { z } from "zod";
import { FederationPage } from "../components/federation/FederationPage";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { resolveFederationSection } from "../lib/federation-navigation";

const searchSchema = z
  .object({
    mediaWorkflow: z.uuid().optional(),
    mediaKind: z.enum(["task-input", "task-result"]).optional(),
  })
  .refine(
    (value) => !!value.mediaWorkflow === !!value.mediaKind,
    "Incomplete media workflow selection",
  );
function FederationRoute() {
  const search = Route.useSearch();
  const hash = useRouterState({ select: (state) => state.location.hash });
  return (
    <ProtectedRoute>
      <FederationPage
        section={resolveFederationSection(hash, !!search.mediaWorkflow)}
        mediaExport={
          search.mediaWorkflow && search.mediaKind
            ? { workflowRunId: search.mediaWorkflow, taskKind: search.mediaKind }
            : undefined
        }
      />
    </ProtectedRoute>
  );
}
export const Route = createFileRoute("/federation")({
  validateSearch: (search) => searchSchema.parse(search),
  component: FederationRoute,
});
