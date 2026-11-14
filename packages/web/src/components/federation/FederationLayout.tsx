import { Inbox } from "lucide-react";
import { Children, createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { federationReadFailed } from "../../lib/federation-query-state";
import { Button } from "../ui/button";

const PageTitle = createContext<string | null>(null);
export const FederationPageTitle = PageTitle.Provider;

export function FederationSectionTitle({ title }: { title: string }) {
  const pageTitle = useContext(PageTitle);
  return pageTitle === title ? null : (
    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
  );
}

export function FederationPanelHeader({ title, children }: { title: string; children: ReactNode }) {
  const pageTitle = useContext(PageTitle);
  const actions = Children.toArray(children);
  if (pageTitle === title && actions.length === 0) return null;
  return (
    <section className="federation-toolbar" aria-label={title}>
      <FederationSectionTitle title={title} />
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
    </section>
  );
}

export function FederationEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="federation-empty" role="status">
      <Inbox aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function FederationLoadError({
  onRetry,
  message,
}: {
  onRetry: () => void;
  message?: string;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p>{message ?? t("federation.loadFailed")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("federation.refresh")}
      </Button>
    </div>
  );
}

export function FederationRefreshNotice({
  query,
  onRetry,
}: {
  query: { isError: boolean; error: unknown; data: unknown };
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!query.isError || federationReadFailed(query)) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <p>{t("federation.refreshFailed")}</p>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t("federation.refresh")}
      </Button>
    </div>
  );
}

export function useFederationAuthRevision() {
  return useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().revision,
    () => null,
  );
}
