import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { SandboxScriptStudio } from "../components/software/SandboxScriptStudio";
import { SoftwarePublisherRoute } from "../components/software/SoftwarePublisherRoute";

export const Route = createFileRoute("/software/scripts/new")({
  component: () => (
    <ProtectedRoute>
      <SoftwarePublisherRoute returnSection="scripts">
        <SandboxScriptStudio />
      </SoftwarePublisherRoute>
    </ProtectedRoute>
  ),
});
