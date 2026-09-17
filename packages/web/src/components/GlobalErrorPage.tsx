import type { ErrorComponentProps } from "@tanstack/react-router";
import { CircleAlert, Home, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";

export function GlobalErrorPage({ reset }: ErrorComponentProps) {
  const { t } = useTranslation();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <section className="w-full max-w-lg text-center" aria-labelledby="global-error-title">
        <CircleAlert className="mx-auto mb-5 h-10 w-10 text-status-warning" aria-hidden="true" />
        <h1 id="global-error-title" className="text-2xl font-semibold text-foreground">
          {t("globalError.title")}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {t("globalError.description")}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button type="button" onClick={reset}>
            <RefreshCw aria-hidden="true" />
            {t("globalError.retry")}
          </Button>
          <Button asChild variant="outline">
            <a href="/">
              <Home aria-hidden="true" />
              {t("globalError.home")}
            </a>
          </Button>
        </div>
      </section>
    </main>
  );
}
