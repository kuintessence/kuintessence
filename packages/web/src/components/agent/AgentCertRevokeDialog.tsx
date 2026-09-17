import { Loader2, ShieldX } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Textarea } from "../ui/input";

export interface AgentCertRevokeDialogCopy {
  title: string;
  description: string;
  fingerprintLabel: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  cancel: string;
  confirm: string;
}

export interface AgentCertRevokeDialogProps {
  open: boolean;
  fingerprintSha256: string | null;
  pending: boolean;
  copy: AgentCertRevokeDialogCopy;
  testIdPrefix: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason?: string) => void;
}

export function AgentCertRevokeDialog({
  open,
  fingerprintSha256,
  pending,
  copy,
  testIdPrefix,
  onOpenChange,
  onConfirm,
}: AgentCertRevokeDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const normalizedReason = reason.trim();
  const reasonId = `${testIdPrefix}-reason-input`;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{copy.fingerprintLabel}</div>
            <code
              className="block max-w-full overflow-hidden text-ellipsis rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
              title={fingerprintSha256 ?? ""}
              data-testid={`${testIdPrefix}-fingerprint`}
            >
              {fingerprintSha256}
            </code>
          </div>
          <label className="block space-y-1" htmlFor={reasonId}>
            <span className="text-xs font-medium text-muted-foreground">{copy.reasonLabel}</span>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={copy.reasonPlaceholder}
              rows={4}
              disabled={pending}
              data-testid={`${testIdPrefix}-reason`}
            />
          </label>
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            data-testid={`${testIdPrefix}-cancel`}
          >
            {copy.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !fingerprintSha256}
            onClick={() => onConfirm(normalizedReason === "" ? undefined : normalizedReason)}
            data-testid={`${testIdPrefix}-confirm`}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldX className="h-3.5 w-3.5" />
            )}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
