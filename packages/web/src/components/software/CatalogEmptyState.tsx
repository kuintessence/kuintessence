import { Link } from "@tanstack/react-router";
import { PackagePlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/content-state";

type CatalogCreateRoute =
  | "/software/workflow-templates/new"
  | "/software/usecases/new"
  | "/software/spack/new"
  | "/software/scripts/new";

export function CatalogEmptyState({
  actionLabel,
  actionTo,
  description,
  icon,
  showAction = true,
  testId,
  title,
}: {
  actionLabel: string;
  actionTo: CatalogCreateRoute;
  description: string;
  icon: ReactNode;
  showAction?: boolean;
  testId: string;
  title: string;
}) {
  return (
    <EmptyState
      data-testid={testId}
      icon={icon}
      title={title}
      description={description}
      actions={
        showAction ? (
          <Button asChild size="sm">
            <Link to={actionTo}>
              <PackagePlus />
              {actionLabel}
            </Link>
          </Button>
        ) : null
      }
    />
  );
}
