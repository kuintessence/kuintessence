import { create } from "@bufbuild/protobuf";
import { type AgentMessage, type ServerMessage, ServerMessageSchema } from "@kuintessence/proto";
import type { AgentHandlerDeps } from "./agent-handler";

export async function receiveInteraction(
  deps: Pick<
    AgentHandlerDeps,
    | "sshGateway"
    | "jobLogsService"
    | "shellExecRegistry"
    | "transferRegistry"
    | "partUrlMinter"
    | "federationAccounting"
  >,
  agent: string,
  message: AgentMessage,
  send: (message: ServerMessage) => void,
) {
  const p = message.payload;
  switch (p.case) {
    case "sshClosed":
    case "sshOutput":
      deps.sshGateway?.handleAgentMessage(agent, message);
      return;
    case "jobLogsResponse":
      deps.jobLogsService?.resolve(
        p.value.requestId,
        { text: p.value.text, error: p.value.error, unavailable: p.value.unavailable },
        agent,
      );
      return;
    case "shellExecResponse":
      deps.shellExecRegistry?.resolve(
        p.value.requestId,
        {
          stdout: p.value.stdout,
          stderr: p.value.stderr,
          error: p.value.error,
          exitCode: p.value.exitCode,
        },
        agent,
      );
      return;
    case "fileTransferProgress": {
      const v = p.value;
      deps.transferRegistry?.update(
        v.requestId,
        {
          copiedBytes: Number(v.copiedBytes),
          state: v.state === "succeeded" || v.state === "failed" ? v.state : "running",
          error: v.error || undefined,
          sha256: v.sha256 || undefined,
          parts: v.parts.map((x) => ({ partNumber: x.partNumber, etag: x.etag })),
        },
        agent,
      );
      return;
    }
    case "partUrlsRequest": {
      const v = p.value;
      if (
        !deps.partUrlMinter ||
        Boolean(v.correlationId) !== Boolean(v.uploadId) ||
        v.correlationId.length > 128 ||
        v.uploadId.length > 1024
      )
        return;
      const urls = await deps.partUrlMinter.mintPartUrlsFor(
        v.requestId,
        v.partNumbers,
        agent,
        v.uploadId || undefined,
      );
      send(
        create(ServerMessageSchema, {
          payload: {
            case: "partUrlsResponse",
            value: {
              requestId: v.requestId,
              correlationId: v.correlationId,
              uploadId: v.uploadId,
              urls,
            },
          },
        }),
      );
      return;
    }
    case "federationAccountingResponse":
      await deps.federationAccounting?.receive(agent, p.value.responseJson);
      return;
  }
}
