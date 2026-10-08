import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMotionPresence } from "../../lib/use-motion-presence";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface DeleteWorkflowDraftDialogProps {
  draft: { id: string; name: string } | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onRestoreFocus: () => void;
}

export function DeleteWorkflowDraftDialog({
  draft,
  pending,
  error,
  onCancel,
  onConfirm,
  onRestoreFocus,
}: DeleteWorkflowDraftDialogProps) {
  const { t } = useTranslation();
  const { snapshot } = useMotionPresence(draft, "--kq-motion-exit");
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent
        dismissible={!pending}
        outsideDismissPolicy="never"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        data-testid="workflow-draft-delete-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("workflows.drafts.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("workflows.drafts.deleteDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="break-all rounded-md border border-border bg-muted/30 p-3 font-medium">
            {(draft ?? snapshot)?.name}
          </p>
          {error ? (
            <div role="alert" className="text-sm text-status-failed">
              {error}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending || draft === null} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || draft === null}
            onClick={onConfirm}
            data-testid="workflow-draft-delete-confirm"
          >
            {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Trash2 />}
            {pending ? t("workflows.drafts.deleting") : t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
