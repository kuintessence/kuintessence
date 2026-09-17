import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CloudPaneEntry } from "../../src/components/files/CloudPane";
import { DeleteCloudFileDialog } from "../../src/components/files/DeleteCloudFileDialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../src/components/ui/dialog";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../src/components/ui/sheet";

const longTitle =
  "Select destination folder for scientific computation results and transfer output files";
const longDescription =
  "Review the selected destination and confirm that all scientific computation output files belong in this folder before continuing.";

function MotionFixture() {
  const [clicks, setClicks] = useState(0);
  const [file, setFile] = useState<CloudPaneEntry | null>(null);
  const [deletions, setDeletions] = useState(0);
  return (
    <main>
      <button type="button" onClick={() => setClicks(clicks + 1)}>
        Underlying {clicks}
      </button>
      <button
        type="button"
        onClick={() =>
          setFile({
            id: "6bf395e6-7a4b-4f0c-a5b6-d2f5d39b8372",
            userId: "fixture-user",
            key: "results/output.txt",
            size: 12,
            contentType: "text/plain",
            createdAt: "2026-09-07T00:00:00Z",
            modifiedAt: "2026-09-07T00:00:00Z",
            etag: "fixture",
          })
        }
      >
        Open deletion
      </button>
      <output data-testid="deletions">{deletions}</output>
      <DeleteCloudFileDialog
        file={file}
        error={null}
        pending={false}
        onCancel={() => setFile(null)}
        onConfirm={() => {
          setDeletions(deletions + 1);
          setFile(null);
        }}
      />
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader data-testid="motion-header">
            <DialogTitle>{longTitle}</DialogTitle>
            <DialogDescription>{longDescription}</DialogDescription>
          </DialogHeader>
          <DialogBody>Review the selected output files.</DialogBody>
          <DialogFooter data-testid="motion-footer">
            <button type="button">Inside dialog</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {(["left", "right"] as const).map((side) => (
        <Sheet key={side}>
          <SheetTrigger>Open {side} sheet</SheetTrigger>
          <SheetContent side={side}>
            <SheetHeader data-testid="motion-header">
              <SheetTitle>{longTitle}</SheetTitle>
              <SheetDescription>{longDescription}</SheetDescription>
            </SheetHeader>
            <SheetBody>Review the selected output files.</SheetBody>
            <SheetFooter data-testid="motion-footer">
              <button type="button">Inside sheet</button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ))}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<MotionFixture />);
