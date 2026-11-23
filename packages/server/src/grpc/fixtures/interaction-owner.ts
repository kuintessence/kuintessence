import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createPgDb } from "@kuintessence/db";
import { AgentMessageSchema } from "@kuintessence/proto";
import { AgentSessions } from "../agent-sessions";
import { AgentDispatcher } from "../dispatcher";
import { InteractionRelay, relayPath } from "../interaction-relay";

const [agent, secret] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (
  !agent ||
  !secret ||
  !url ||
  !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname) ||
  !process.send
)
  throw new Error("Invalid relay fixture");
const db = createPgDb(url, { max: 2 });
const directory = await mkdtemp(join(tmpdir(), "kq-relay-cert-"));
const key = join(directory, "key.pem"),
  cert = join(directory, "cert.pem");
let tls: { key: string; cert: string };
try {
  const issue = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (issue.exitCode) throw new Error("Test TLS certificate generation failed");
  tls = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
} finally {
  await rm(directory, { recursive: true, force: true });
}
type Binding = NonNullable<ReturnType<InteractionRelay["authorize"]>>;
type SocketData = { binding: Binding; flow?: ReturnType<InteractionRelay["accept"]> };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls,
  fetch(req, s) {
    const token = req.headers.get("authorization") ?? undefined;
    const binding = relay.authorize(token);
    if (new URL(req.url).pathname !== relayPath || !binding || relay.authorize(token))
      return new Response(null, { status: 403 });
    if (!s.upgrade(req, { data: { binding } })) return new Response(null, { status: 400 });
  },
  websocket: {
    data: {} as SocketData,
    open(ws) {
      ws.binaryType = "arraybuffer";
      ws.data.flow = relay.accept(ws.data.binding, {
        get bufferedAmount() {
          return ws.getBufferedAmount();
        },
        send(bytes) {
          if (!ws.sendBinary(bytes)) throw new Error("Socket closed");
        },
        close() {
          ws.close();
        },
      });
    },
    message(ws, bytes) {
      ws.data.flow?.command(bytes);
    },
    close(ws) {
      ws.data.flow?.finish();
    },
  },
});
const origin = "wss://127.0.0.1:" + server.port;
const sessions = new AgentSessions(db, 90, origin);
const session = crypto.randomUUID();
await sessions.claim(agent, session, { schedulerLimits: false, pinnedSpack: false });
const dispatcher = new AgentDispatcher();
const relay = new InteractionRelay({
  sessions,
  origins: [],
  secret,
  local: (a) => dispatcher.getChannel(a),
  receive: async () => {},
});
dispatcher.register(agent, {
  controlSessionId: session,
  close: () => {},
  push: (message) => {
    const p = message.payload;
    process.send?.({ kind: "command", name: p.case });
    if (p.case === "jobLogsRequest")
      relay.reply(
        agent,
        session,
        create(AgentMessageSchema, {
          payload: {
            case: "jobLogsResponse",
            value: { requestId: p.value.requestId, text: "owner logs" },
          },
        }),
      );
    if (p.case === "sshData")
      relay.reply(
        agent,
        session,
        create(AgentMessageSchema, {
          payload: {
            case: "sshOutput",
            value: { sessionId: p.value.sessionId, data: p.value.data },
          },
        }),
      );
  },
});
process.send({ kind: "registered", origin, cert: tls.cert });
