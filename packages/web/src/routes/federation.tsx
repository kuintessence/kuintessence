import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { FederationPage } from "../components/federation/FederationPage";
import { ProtectedRoute } from "../components/ProtectedRoute";

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
  return (
    <ProtectedRoute>
      <FederationPage
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
