import { randomUUID } from "node:crypto";
import { AppError, ErrorCode } from "@kuintessence/shared";
import type { AgentDispatcher } from "../grpc/dispatcher";

export interface JobLogsResult {
  text: string;
  error: string;
  unavailable?: boolean;
}

export class JobLogsUnavailableError extends Error {
  constructor() {
    super("Job log file is not available");
    this.name = "JobLogsUnavailableError";
  }
}

interface PendingJobLogs {
  resolve: (result: JobLogsResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JobLogsService {
  private readonly pending = new Map<string, PendingJobLogs>();

  constructor(
    private readonly dispatcher: AgentDispatcher,
    private readonly timeoutMs = 10_000,
  ) {}

  async get(
    agentId: string,
    schedulerJobId: string,
    lines: number,
    jobId: string,
    restrictedNoEgress: boolean,
  ): Promise<string> {
    const requestId = randomUUID();
    const response = new Promise<JobLogsResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new Error(`job logs ${requestId} timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });

    if (
      !this.dispatcher.pushJobLogsRequest(
        agentId,
        requestId,
        schedulerJobId,
        lines,
        jobId,
        restrictedNoEgress,
      )
    ) {
      this.discard(requestId);
      throw new AppError(ErrorCode.AGENT_OFFLINE, `Agent ${agentId} is not online`, 503, {
        agentId,
      });
    }

    let result: JobLogsResult;
    try {
      result = await response;
    } catch (error) {
      throw new AppError(ErrorCode.AGENT_OFFLINE, "Job logs request did not complete", 504, {
        agentId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (result.error) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Agent could not read job logs", 502, {
        agentId,
        cause: result.error,
      });
    }
    if (result.unavailable) {
      throw new JobLogsUnavailableError();
    }
    return result.text;
  }

  resolve(requestId: string, result: JobLogsResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(result);
    return true;
  }

  discard(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    return true;
  }
}
