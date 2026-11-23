import { create } from "@bufbuild/protobuf";
import {
  type AgentMessage,
  AgentMessageSchema,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";

export type InteractionKind =
  | "ssh"
  | "shell"
  | "logs"
  | "transfer"
  | "accounting"
  | "replica-read"
  | "replica-result";
export interface Interaction {
  kind: InteractionKind;
  id: string;
  open?: boolean;
  terminal?: boolean;
}
function accountingId(json: string, response: boolean): string | undefined {
  if (json.length > 32768) return;
  try {
    const value = JSON.parse(json);
    const id = response ? value?.request?.requestId : value?.requestId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return;
  }
}
export function commandFlow({ payload: p }: ServerMessage): Interaction | undefined {
  switch (p.case) {
    case "replicaRangeRead":
    case "replicaRangeResult":
      return {
        kind: p.case === "replicaRangeRead" ? "replica-read" : "replica-result",
        id: p.value.range?.requestId ?? "",
        open: true,
        terminal: true,
      };
    case "sshRouteOpen":
      return { kind: "ssh", id: p.value.destination?.sessionId ?? "", open: true };
    case "sftpOpen":
    case "sshOpen":
      return { kind: "ssh", id: p.value.sessionId, open: true };
    case "sshClose":
    case "sshResize":
    case "sshData":
      return { kind: "ssh", id: p.value.sessionId };
    case "shellExecRequest":
      return { kind: "shell", id: p.value.requestId, open: true };
    case "jobLogsRequest":
      return { kind: "logs", id: p.value.requestId, open: true };
    case "fileTransferRequest":
      return { kind: "transfer", id: p.value.requestId, open: true };
    case "fileTransferCancel":
    case "partUrlsResponse":
      return { kind: "transfer", id: p.value.requestId };
    case "federationAccountingRequest":
      return { kind: "accounting", id: accountingId(p.value.requestJson, false) ?? "", open: true };
  }
}
export function replyFlow({ payload: p }: AgentMessage): Interaction | undefined {
  switch (p.case) {
    case "sshOutput":
    case "sshClosed":
      return { kind: "ssh", id: p.value.sessionId, terminal: p.case === "sshClosed" };
    case "shellExecResponse":
      return { kind: "shell", id: p.value.requestId, terminal: true };
    case "jobLogsResponse":
      return { kind: "logs", id: p.value.requestId, terminal: true };
    case "fileTransferProgress":
      return {
        kind: "transfer",
        id: p.value.requestId,
        terminal: ["failed", "succeeded", "cancelled"].includes(p.value.state),
      };
    case "partUrlsRequest":
      return { kind: "transfer", id: p.value.requestId };
    case "federationAccountingResponse":
      return {
        kind: "accounting",
        id: accountingId(p.value.responseJson, true) ?? "",
        terminal: true,
      };
  }
}

export function lostInteraction({ kind, id }: Interaction): AgentMessage | undefined {
  const reason = "Agent control connection lost";
  switch (kind) {
    case "ssh":
      return create(AgentMessageSchema, {
        payload: { case: "sshClosed", value: { sessionId: id, reason } },
      });
    case "logs":
      return create(AgentMessageSchema, {
        payload: { case: "jobLogsResponse", value: { requestId: id, error: reason } },
      });
    case "shell":
      return create(AgentMessageSchema, {
        payload: {
          case: "shellExecResponse",
          value: { requestId: id, error: reason, exitCode: -1 },
        },
      });
    case "transfer":
      return create(AgentMessageSchema, {
        payload: {
          case: "fileTransferProgress",
          value: { requestId: id, error: reason, state: "failed" },
        },
      });
  }
}

export function cancelInteraction({ kind, id }: Interaction): ServerMessage | undefined {
  if (kind === "ssh")
    return create(ServerMessageSchema, {
      payload: { case: "sshClose", value: { sessionId: id, reason: "Server disconnected" } },
    });
  if (kind === "transfer")
    return create(ServerMessageSchema, {
      payload: { case: "fileTransferCancel", value: { requestId: id } },
    });
}
