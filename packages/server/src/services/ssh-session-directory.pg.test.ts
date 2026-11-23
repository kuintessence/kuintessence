import { expect, test } from "bun:test";
import { createPgDb } from "@kuintessence/db";
import { AgentDispatcher } from "../grpc/dispatcher";
import { SshGateway } from "./ssh-gateway";
import { SshSessionDirectory } from "./ssh-session-directory";

test("another Server lists and closes a session after the owner acknowledges", async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.startsWith("/kuintessence_unit_"))
    throw new Error("Requires an isolated unit database");
  const db = createPgDb(url);
  const dispatcher = new AgentDispatcher();
  const agentCommands: string[] = [];
  dispatcher.register("agent", {
    push: (message) => {
      agentCommands.push(message.payload.case ?? "empty");
    },
    close: () => {},
  });
  const gateway = new SshGateway({ dispatcher });
  const closed: string[] = [];
  const id = gateway.openSession({
    agentId: "agent",
    user: "fixture",
    credentials: { host: "fixture.example", port: 22, username: "fixture" },
    ws: {
      send: () => {},
      close: (_code, reason) => {
        closed.push(reason ?? "");
      },
    },
  });
  const owner = new SshSessionDirectory(db, crypto.randomUUID(), gateway);
  const admin = new SshSessionDirectory(
    db,
    crypto.randomUUID(),
    new SshGateway({ dispatcher: new AgentDispatcher() }),
  );
  try {
    await owner.sync();
    expect((await admin.listSessions()).some((s) => s.sessionId === id)).toBe(true);
    owner.start();
    await admin.closeSession(id, "force-closed by fixture");
    expect(gateway.hasSession(id)).toBe(false);
    expect(agentCommands).toEqual(["sshOpen", "sshClose"]);
    expect(closed).toEqual(["force-closed by fixture"]);
    expect((await admin.listSessions()).some((s) => s.sessionId === id)).toBe(false);
  } finally {
    await owner.stop();
    await db.$client.end();
  }
});
