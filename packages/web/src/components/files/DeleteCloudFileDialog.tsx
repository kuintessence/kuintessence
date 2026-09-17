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
import type { CloudPaneEntry } from "./CloudPane";
import { fmtBytes } from "./path-picker-utils";

interface DeleteCloudFileDialogProps {
  file: CloudPaneEntry | null;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteCloudFileDialog({
  file,
  error,
  pending,
  onCancel,
  onConfirm,
}: DeleteCloudFileDialogProps) {
  const { t } = useTranslation();
  const { snapshot } = useMotionPresence(file, "--kq-motion-exit");
  const displayFile = file ?? snapshot;

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent
        dismissible={!pending}
        outsideDismissPolicy="never"
        data-testid="files-delete-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("files.deleteDialog.title")}</DialogTitle>
          <DialogDescription>{t("files.deleteDialog.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="break-all font-mono text-sm font-medium">{displayFile?.key}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("files.deleteDialog.size", { size: fmtBytes(displayFile?.size) })}
            </div>
          </div>
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-status-failed/30 bg-status-failed/10 px-3 py-2 text-xs text-status-failed"
              data-testid="files-delete-error"
            >
              {error}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={pending || file === null} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || file === null}
            onClick={onConfirm}
            data-testid="files-delete-confirm"
          >
            {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {pending ? t("files.deleteDialog.deleting") : t("files.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
