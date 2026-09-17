import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SoftwarePolicyEdit, SoftwarePolicyList } from "../../lib/cp-client";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";

export interface EditPolicyDialogProps {
  open: boolean;
  cluster: string;
  list: SoftwarePolicyList;
  initialSpecs: string[];
  onSubmit: (payload: SoftwarePolicyEdit) => void;
  onClose: () => void;
  /** Set to true while the mutation is pending; disables the submit button. */
  isSubmitting?: boolean;
  /** Optional error message shown above the form. */
  error?: string | null;
}

/**
 * Inline modal (no portal) so happy-dom tests can assert on the dialog
 * contents without orchestrating Radix Portal lifecycle. The shadcn
 * `<Sheet>` primitive uses Radix Portal, which makes assertions awkward
 * without testing-library/dom's portal helpers — and we don't want to
 * pull new dependencies in for this view.
 */
export function EditPolicyDialog(props: EditPolicyDialogProps) {
  const { t } = useTranslation();
  const { open, cluster, list, initialSpecs, onSubmit, onClose, isSubmitting, error } = props;
  const [text, setText] = useState<string>(() => initialSpecs.join("\n"));
  const [currentList, setCurrentList] = useState<SoftwarePolicyList>(list);

  useEffect(() => {
    if (open) {
      setText(initialSpecs.join("\n"));
      setCurrentList(list);
    }
  }, [open, initialSpecs, list]);

  if (!open) return null;

  const handleSubmit = () => {
    const specs = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    onSubmit({ cluster, list: currentList, specs });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      data-testid="edit-policy-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-2xl shadow-black/15">
        <div className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold tracking-tight">
              {t("cp.software.edit.title")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("cp.software.edit.description")}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            data-testid="edit-policy-close"
            onClick={onClose}
            aria-label={t("cp.common.cancel")}
          >
            <X />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          <div className="text-xs text-muted-foreground">
            <span className="font-mono">{cluster}</span>
          </div>

          {error ? (
            <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-2 text-xs">
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <label htmlFor="edit-policy-list" className="text-xs font-medium">
              {t("cp.software.edit.listLabel")}
            </label>
            <select
              id="edit-policy-list"
              data-testid="edit-policy-list"
              value={currentList}
              onChange={(e) => setCurrentList(e.target.value as SoftwarePolicyList)}
              className="h-9 rounded-md border border-border bg-card px-3 text-sm shadow-sm"
            >
              <option value="whitelist">{t("cp.software.edit.listWhitelist")}</option>
              <option value="blacklist">{t("cp.software.edit.listBlacklist")}</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="edit-policy-specs" className="text-xs font-medium">
              {t("cp.software.edit.specsLabel")}
            </label>
            <Textarea
              id="edit-policy-specs"
              data-testid="edit-policy-specs"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("cp.software.edit.specsPlaceholder")}
              rows={8}
              className="font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border bg-card/95 px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} data-testid="edit-policy-cancel">
            {t("cp.common.cancel")}
          </Button>
          <Button
            data-testid="edit-policy-submit"
            onClick={handleSubmit}
            disabled={isSubmitting === true}
          >
            {t("cp.software.edit.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
