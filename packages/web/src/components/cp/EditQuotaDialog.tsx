import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface EditQuotaDialogProps {
  open: boolean;
  userId: string;
  email: string;
  initialQuota: number;
  onSubmit: (quota: number) => void;
  onClose: () => void;
  isSubmitting?: boolean;
  error?: string | null;
}

export function EditQuotaDialog(props: EditQuotaDialogProps) {
  const { t } = useTranslation();
  const { open, email, initialQuota, onSubmit, onClose, isSubmitting, error } = props;
  const [value, setValue] = useState<string>(() => String(initialQuota));
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(String(initialQuota));
      setValidation(null);
    }
  }, [open, initialQuota]);

  if (!open) return null;

  const handleSubmit = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      setValidation(t("cp.users.quotaInvalid"));
      return;
    }
    onSubmit(n);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      data-testid="edit-quota-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-sm flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-2xl shadow-black/15">
        <div className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold tracking-tight">
              {t("cp.users.editQuotaTitle")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("cp.users.editQuotaDescription")}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            data-testid="edit-quota-close"
            aria-label={t("cp.common.cancel")}
          >
            <X />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          <div className="text-xs text-muted-foreground">
            <span className="font-mono">{email}</span>
          </div>

          {(error || validation) && (
            <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-2 text-xs">
              {validation ?? error}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="edit-quota-input" className="text-xs font-medium">
              {t("cp.users.quotaLabel")}
            </label>
            <Input
              id="edit-quota-input"
              data-testid="edit-quota-input"
              type="number"
              min={0}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border bg-card/95 px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} data-testid="edit-quota-cancel">
            {t("cp.common.cancel")}
          </Button>
          <Button
            data-testid="edit-quota-submit"
            onClick={handleSubmit}
            disabled={isSubmitting === true}
          >
            {t("cp.common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
