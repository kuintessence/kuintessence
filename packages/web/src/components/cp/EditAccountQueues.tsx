import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { type SandboxExecutionAccount, updateSandboxAccountQueues } from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export function EditAccountQueues({
  account,
  onClose,
  onSaved,
}: {
  account: SandboxExecutionAccount;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [queues, setQueues] = useState(account.allowedQueues.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent aria-describedby={`${id}-hint`} dirty outsideDismissPolicy="never">
        <DialogHeader>
          <DialogTitle>
            {t("cp.accounts.editQueues")} · {account.displayName}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await updateSandboxAccountQueues(account.id, [
                ...new Set(
                  queues
                    .split(",")
                    .map((name) => name.trim())
                    .filter(Boolean),
                ),
              ]);
              await onSaved();
            } catch (error) {
              setError(toUserFacingError(error, t("cp.accounts.queuesSaveFailed")));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="grid gap-2 text-sm" htmlFor={id}>
            {t("cp.accounts.registration.allowedQueues")}
            <Input
              id={id}
              value={queues}
              disabled={busy}
              onChange={(event) => setQueues(event.target.value)}
              aria-describedby={`${id}-hint`}
            />
          </label>
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            {t("cp.accounts.registration.emptyQueuesHint")}
          </p>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cp.common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(busy ? "cp.common.saving" : "cp.common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
