import type { SpackMaterialBinding } from "@kuintessence/shared/browser";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { MaterialLifecycle } from "./MaterialLifecycle";
import { MaterialVisibility } from "./MaterialVisibility";

export function MaterialManagementEditors({
  initialBinding,
  isCurrent,
  canWriteRepository,
  canInspectRepository,
  onInvalidate,
  onSelectionLockChange,
}: {
  initialBinding?: SpackMaterialBinding;
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
  canInspectRepository: (repository: string) => boolean;
  onInvalidate: () => void;
  onSelectionLockChange?: (locked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState("lifecycle");
  const [locked, setLocked] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const currentGeneration = generation.current;
  const current = () => isCurrent() && generation.current === currentGeneration;
  const props = {
    initialBinding,
    isCurrent: current,
    canWriteRepository,
    canInspectRepository,
    onInvalidate,
    onSelectionLockChange: (value: boolean) => {
      if (!current()) return;
      lock.current = value;
      setLocked(value);
      onSelectionLockChange?.(value);
    },
  };
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => {
        if (!current() || lock.current || value === mode) return;
        if (value !== "lifecycle" && value !== "visibility") return;
        // Only one editor is mounted. An old read cannot release the new editor's lock.
        generation.current += 1;
        setMode(value);
      }}
    >
      <TabsList aria-label={t("materials.managementEditors")}>
        <TabsTrigger value="lifecycle" disabled={locked}>
          {t("materials.lifecycleTab")}
        </TabsTrigger>
        <TabsTrigger value="visibility" disabled={locked}>
          {t("materials.visibilityTab")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="lifecycle">
        {mode === "lifecycle" ? <MaterialLifecycle {...props} /> : null}
      </TabsContent>
      <TabsContent value="visibility">
        {mode === "visibility" ? <MaterialVisibility {...props} /> : null}
      </TabsContent>
    </Tabs>
  );
}
