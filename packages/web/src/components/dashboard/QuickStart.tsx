import { GitBranch, ListTodo, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import helloYaml from "../../../../../examples/workflows/hello.yaml?raw";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface SubmitResp {
  runId: string;
  name?: string;
  status: string;
}

interface JobResp {
  id: string;
  name: string;
  status: string;
}

const DEMO_JOB_BODY = {
  name: "demo-hello",
  command: 'echo "hello from kq dashboard"',
  resources: { cpus: 1, memoryMb: 1024 },
};

export interface QuickStartProps {
  onSubmitted?: () => void;
}

export function QuickStart({ onSubmitted }: QuickStartProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"job" | "workflow" | null>(null);

  async function submitJob() {
    setBusy("job");
    try {
      const r = await api.post<JobResp>("/jobs", DEMO_JOB_BODY);
      toast.success(t("quickStart.submittedJob", { id: r.id.slice(0, 8) }));
      onSubmitted?.();
    } catch (err) {
      toast.error(toUserFacingError(err, t("quickStart.failedJob")));
    } finally {
      setBusy(null);
    }
  }

  async function submitWorkflow() {
    setBusy("workflow");
    try {
      const r = await api.post<SubmitResp>("/workflows", { yaml: helloYaml });
      toast.success(t("quickStart.startedWorkflow", { id: r.runId.slice(0, 8), count: 1 }));
      onSubmitted?.();
    } catch (err) {
      toast.error(toUserFacingError(err, t("quickStart.failedWorkflow")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="quick-start">
      <CardHeader>
        <CardTitle>{t("quickStart.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">{t("quickStart.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={submitJob} disabled={busy !== null} data-testid="quick-start-submit-job">
            {busy === "job" ? <Loader2 className="animate-spin" /> : <ListTodo />}
            {t("quickStart.submitDemoJob")}
          </Button>
          <Button
            onClick={submitWorkflow}
            variant="outline"
            disabled={busy !== null}
            data-testid="quick-start-submit-workflow"
          >
            {busy === "workflow" ? <Loader2 className="animate-spin" /> : <GitBranch />}
            {t("quickStart.runHelloWorld")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
