import { createRootRoute, Link } from "@tanstack/react-router";
import { Home, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/ui/button";

function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-12">
      <section className="w-full max-w-lg text-center" aria-labelledby="not-found-title">
        <SearchX className="mx-auto mb-5 h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <h1 id="not-found-title" className="text-2xl font-semibold text-foreground">
          {t("notFound.title")}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("notFound.description")}</p>
        <Button asChild className="mt-7">
          <Link to="/">
            <Home aria-hidden="true" />
            {t("notFound.home")}
          </Link>
        </Button>
      </section>
    </main>
  );
}

export const Route = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});
