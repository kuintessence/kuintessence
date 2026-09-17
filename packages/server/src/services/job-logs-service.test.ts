import { describe, expect, test } from "bun:test";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobLogsService, JobLogsUnavailableError } from "./job-logs-service";

describe("JobLogsService", () => {
  test("dispatches a typed request and resolves the matching response", async () => {
    const dispatcher = new AgentDispatcher();
    const messages: unknown[] = [];
    dispatcher.register("agent-1", {
      push: (message) => messages.push(message),
      close: () => undefined,
    });
    const service = new JobLogsService(dispatcher);

    const pending = service.get("agent-1", "scheduler-42", 200, "job-1", false);
    const message = messages[0] as {
      payload: {
        case: string;
        value: {
          requestId: string;
          schedulerJobId: string;
          lines: number;
          jobId: string;
          restrictedNoEgress: boolean;
        };
      };
    };
    expect(message.payload).toMatchObject({
      case: "jobLogsRequest",
      value: {
        schedulerJobId: "scheduler-42",
        lines: 200,
        jobId: "job-1",
        restrictedNoEgress: false,
      },
    });
    expect(service.resolve(message.payload.value.requestId, { text: "done\n", error: "" })).toBe(
      true,
    );
    expect(await pending).toBe("done\n");
  });

  test("fails immediately when the target agent is offline", async () => {
    const service = new JobLogsService(new AgentDispatcher());

    expect(service.get("offline-agent", "scheduler-42", 200, "job-1", false)).rejects.toMatchObject(
      {
        code: "AGENT_OFFLINE",
        statusCode: 503,
      },
    );
  });

  test("maps an Agent adapter error to a gateway failure", async () => {
    const dispatcher = new AgentDispatcher();
    let requestId = "";
    dispatcher.register("agent-1", {
      push: (message) => {
        if (message.payload.case !== "jobLogsRequest") {
          throw new Error("expected jobLogsRequest");
        }
        requestId = message.payload.value.requestId;
      },
      close: () => undefined,
    });
    const service = new JobLogsService(dispatcher);

    const pending = service.get("agent-1", "scheduler-42", 200, "job-1", false);
    service.resolve(requestId, { text: "", error: "scheduler output unavailable" });

    expect(pending).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 502 });
  });

  test("keeps a known missing log distinct from an Agent adapter failure", async () => {
    const dispatcher = new AgentDispatcher();
    let requestId = "";
    dispatcher.register("agent-1", {
      push: (message) => {
        if (message.payload.case !== "jobLogsRequest") {
          throw new Error("expected jobLogsRequest");
        }
        requestId = message.payload.value.requestId;
      },
      close: () => undefined,
    });
    const service = new JobLogsService(dispatcher);

    const pending = service.get("agent-1", "scheduler-42", 200, "job-1", false);
    service.resolve(requestId, { text: "", error: "", unavailable: true });

    expect(pending).rejects.toBeInstanceOf(JobLogsUnavailableError);
  });
});
