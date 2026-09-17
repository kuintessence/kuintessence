import { createFileRoute } from "@tanstack/react-router";
import { SandboxScriptStudio } from "../components/software/SandboxScriptStudio";

function SandboxScriptDetailRoute() {
  const { scriptId } = Route.useParams();
  return <SandboxScriptStudio scriptId={scriptId} />;
}

export const Route = createFileRoute("/software/scripts/$scriptId")({
  component: SandboxScriptDetailRoute,
});
