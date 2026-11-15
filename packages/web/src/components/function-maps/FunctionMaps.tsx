import { FederationCurrentCapabilitiesSchema } from "@kuintessence/shared/federation";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { isLocalMode, useLocalCapabilities } from "../../lib/local-mode";
import { toCapabilitySet, useMeCapabilities } from "../../lib/platform-capabilities";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { mapDestination, visibleMap } from "./access";
import catalog from "./catalog.json";
import { FunctionMapView } from "./FunctionMapView";
import { type FunctionMap, type MapNode, type MapRuntime, mapText } from "./model";

export const FUNCTION_MAPS: readonly FunctionMap[] = catalog as FunctionMap[];
export interface FunctionMapsProps {
  ids: readonly string[];
  runtime?: MapRuntime;
  onOpen?: (node: MapNode) => boolean;
  hiddenNodeIds?: readonly string[];
}
export function FunctionMaps(props: FunctionMapsProps) {
  useSyncExternalStore(
    subscribeAuthState,
    () => `${getAuthState().revision}:${getAuthState().role}`,
    () => "",
  );
  const organizationId = useActiveOrganizationId();
  const auth = getAuthState();
  if (!auth.isAuthenticated) return null;
  // Scope changes reset selection and explanation before another organization's data can render.
  return <ScopedMaps key={`${organizationId}:${auth.revision}:${auth.role}`} {...props} />;
}
function ScopedMaps({ ids, runtime, onOpen, hiddenNodeIds = [] }: FunctionMapsProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const auth = getAuthState();
  const organizationId = useActiveOrganizationId();
  const local = isLocalMode();
  const localCapabilities = useLocalCapabilities();
  const platform = useMeCapabilities(auth.isAuthenticated && !local);
  const models = FUNCTION_MAPS.filter((model) => ids.includes(model.id)).map((model) => ({
    ...model,
    nodes: model.nodes.filter((node) => !hiddenNodeIds.includes(node.id)),
  }));
  const needsFederation = models.some((model) =>
    model.nodes.some((node) => node.route.startsWith("/federation#")),
  );
  const federation = useQuery({
    queryKey: ["federation", "current-capabilities", organizationId, auth.revision],
    enabled: needsFederation && !!organizationId && auth.isAuthenticated && !local,
    queryFn: async ({ signal }) =>
      FederationCurrentCapabilitiesSchema.parse(
        (
          await api.get<{ data: unknown }>(
            "/federation/capabilities",
            { organizationId: organizationId ?? "", authRevision: auth.revision },
            signal,
          )
        ).data,
      ),
    retry: false,
  });
  const grants =
    !federation.isError && federation.data?.orgId === organizationId
      ? federation.data.effectiveCapabilities
      : [];
  const access = {
    role: auth.role,
    local,
    localCapabilities,
    platform: toCapabilitySet(platform.data),
    federation: new Set(grants),
    ready: local ? !!localCapabilities : platform.status === "ready",
  };
  const allowed = models.filter((model) => visibleMap(model, access).nodes.length > 0);
  const [chosen, setChosen] = useState(ids[0]);
  const model = allowed.find((item) => item.id === chosen) ?? allowed[0];
  if (!model) {
    if (platform.status === "error" || (needsFederation && federation.isError))
      return (
        <div role="alert" className="border-b border-border py-3 text-sm">
          {t("functionMaps.permissionFailed")}
          <Button
            variant="link"
            onClick={() => {
              platform.retry();
              void federation.refetch();
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      );
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        {t(access.ready ? "functionMaps.noAccess" : "common.loading")}
      </p>
    );
  }
  const graph = visibleMap(
    model.id === "G05" && runtime?.nodes
      ? {
          ...model,
          nodes: runtime.nodes,
          edges: runtime.edges ?? [],
        }
      : model,
    access,
  );
  return (
    <section
      className="min-w-0 border-b border-border pb-4"
      aria-label={t("functionMaps.portal")}
      data-function-maps={ids.join(" ")}
    >
      {allowed.length > 1 ? (
        <label className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{t("functionMaps.choose")}</span>
          <NativeSelect
            value={model.id}
            onChange={(event) => setChosen(event.target.value)}
            className="max-w-full sm:max-w-md"
          >
            {allowed.map((item) => (
              <option key={item.id} value={item.id}>
                {mapText(item.title, i18n.language)}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {needsFederation && (federation.isPending || federation.isError) ? (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {t("functionMaps.partialAccess")}
        </p>
      ) : null}
      <FunctionMapView
        key={`${model.id}:${graph.nodes.map((node) => node.id).join(",")}`}
        model={graph}
        language={i18n.language}
        runtime={model.type === "runtime" ? runtime : undefined}
        onOpen={(node) => {
          if (!onOpen?.(node)) void navigate(mapDestination(node, location.search));
        }}
      />
    </section>
  );
}
