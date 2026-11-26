import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useMediaQuery } from "../../lib/use-media-query";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { MapPreferenceFields } from "./MapPreferenceFields";
import {
  initialMapDisplay,
  type MapDisplay,
  type MapRule,
  mapRule,
  useMapPreferences,
} from "./preferences";

export function FunctionMapRegion({
  page,
  title,
  type,
  diagram,
  dashboard,
  common,
  recommended = dashboard !== undefined ? "data" : "expanded",
  nodeTarget = false,
  urlDisplay,
  diagramAvailable = true,
}: {
  page: string;
  title: string;
  type: "process" | "dependency" | "runtime";
  diagram: ReactNode;
  dashboard?: ReactNode;
  common?: ReactNode;
  recommended?: MapDisplay;
  nodeTarget?: boolean;
  urlDisplay?: unknown;
  diagramAvailable?: boolean;
}) {
  const { t } = useTranslation();
  const { prefs, update } = useMapPreferences();
  const presentation = dashboard !== undefined ? "dual" : "single";
  const [current, setCurrent] = useState(() =>
    initialMapDisplay({
      prefs,
      page,
      presentation,
      recommended,
      nodeTarget,
      url: urlDisplay,
    }),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mobile = useMediaQuery("(max-width: 767px)");
  useEffect(() => {
    if (mobile) setSettingsOpen(false);
  }, [mobile]);
  const [draft, setDraft] = useState<MapRule>(() => mapRule(prefs, page, presentation));
  const panelId = useId();
  const diagramLabel = t(`functionMaps.views.${type}`);
  function change(value: MapDisplay) {
    setCurrent(value);
    if (mapRule(prefs, page, presentation).mode === "memory") {
      try {
        update((stored) => ({
          ...stored,
          pages: {
            ...stored.pages,
            [page]: { ...stored.pages[page], last: value },
          },
        }));
      } catch {
        toast.error(t("functionMaps.preferences.saveFailed"));
      }
    }
  }
  const settings = (
    <Popover
      open={settingsOpen}
      onOpenChange={(open) => {
        if (open) setDraft(mapRule(prefs, page, presentation));
        setSettingsOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <Settings2 aria-hidden="true" />
          {t("functionMaps.preferences.viewSettings")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-4 p-4">
        <MapPreferenceFields value={draft} presentation={presentation} onChange={setDraft} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              try {
                update((stored) => ({
                  ...stored,
                  pages: { ...stored.pages, [page]: { last: stored.pages[page]?.last } },
                }));
                setSettingsOpen(false);
                toast.success(t("functionMaps.preferences.saved"));
              } catch {
                toast.error(t("functionMaps.preferences.saveFailed"));
              }
            }}
          >
            {t("functionMaps.preferences.inherit")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              try {
                update((stored) => ({
                  ...stored,
                  pages: { ...stored.pages, [page]: { ...stored.pages[page], ...draft } },
                }));
                setSettingsOpen(false);
                toast.success(t("functionMaps.preferences.saved"));
              } catch {
                toast.error(t("functionMaps.preferences.saveFailed"));
              }
            }}
          >
            {t("common.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("functionMaps.preferences.centralAppearance")}
        </p>
      </PopoverContent>
    </Popover>
  );
  if (presentation === "dual") {
    const visible = diagramAvailable ? current : "data";
    return (
      <section className="map-region min-w-0 space-y-4" data-map-region={page}>
        {common}
        <Tabs value={visible} onValueChange={(value) => change(value as MapDisplay)}>
          <div className="map-region-toolbar mb-4 hidden items-center justify-between gap-3 md:flex">
            {diagramAvailable ? (
              <TabsList aria-label={title}>
                <TabsTrigger value="diagram">{diagramLabel}</TabsTrigger>
                <TabsTrigger value="data">{t("functionMaps.views.data")}</TabsTrigger>
              </TabsList>
            ) : (
              <h2 className="text-sm font-semibold">{t("functionMaps.views.data")}</h2>
            )}
            {settings}
          </div>
          {diagramAvailable ? (
            <TabsContent
              forceMount
              value="diagram"
              className="map-region-diagram data-[state=inactive]:hidden"
            >
              {diagram}
            </TabsContent>
          ) : null}
          <TabsContent
            forceMount
            value="data"
            className="map-region-data data-[state=inactive]:hidden"
          >
            {dashboard}
          </TabsContent>
        </Tabs>
      </section>
    );
  }
  const expanded = current === "expanded";
  return (
    <section
      className="map-region map-region-single min-w-0 border-b border-border pb-3"
      data-map-region={page}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-1">
          {settings}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => change(expanded ? "collapsed" : "expanded")}
          >
            {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            {t(expanded ? "functionMaps.collapse" : "functionMaps.expand")}
          </Button>
        </div>
      </div>
      <div id={panelId} hidden={!expanded} className="pt-3">
        {diagram}
      </div>
    </section>
  );
}
