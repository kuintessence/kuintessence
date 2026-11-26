import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { agents, createPgDb } from "@kuintessence/db";
import { type AgentMessage, ServerMessageSchema } from "@kuintessence/proto";
import { eq } from "drizzle-orm";
import { AgentSessions } from "./agent-sessions";
import { AgentDispatcher } from "./dispatcher";
import { InteractionRelay } from "./interaction-relay";

test("a second process routes ordered SSH frames and log replies to their origin and fences a takeover", async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
    throw new Error("Requires isolated test database");
  const db = createPgDb(url, { max: 3 });
  const agent = crypto.randomUUID(),
    secret = crypto.randomUUID();
  const sessions = new AgentSessions(db, 90);
  const dispatcher = new AgentDispatcher();
  await db.insert(agents).values({
    agentId: agent,
    siteName: "relay fixture",
    schedulerType: "slurm",
    schedulerVersion: "fixture",
  });
  const registered = Promise.withResolvers<{ origin: string; cert: string }>();
  const received: AgentMessage[] = [];
  const commands: string[] = [];
  let wake = () => {};
  async function until(check: () => boolean) {
    const limit = AbortSignal.timeout(4000);
    while (!check()) {
      limit.throwIfAborted();
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20);
      });
    }
  }
  const peer = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/interaction-owner.ts", import.meta.url).pathname,
      agent,
      secret,
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      ipc(m: { kind: string; origin: string; cert: string; name: string }) {
        if (m.kind === "registered") registered.resolve(m);
        if (m.kind === "command") commands.push(m.name);
        wake();
      },
    },
  );
  let relay: InteractionRelay | undefined;
  try {
    const { origin, cert } = await Promise.race([
      registered.promise,
      peer.exited.then(() => {
        throw new Error("owner exited");
      }),
    ]);
    relay = new InteractionRelay({
      sessions,
      origins: [origin],
      secret,
      local: (id) => dispatcher.getChannel(id),
      receive: async (id, m) => {
        expect(id).toBe(agent);
        received.push(m);
        wake();
      },
      connect: (url, token) =>
        new WebSocket(url, { headers: { Authorization: "Bearer " + token }, tls: { ca: cert } }),
    });
    await relay.refresh();
    dispatcher.interactionRelay = relay;
    expect(dispatcher.onlineAgentIds()).toEqual([]);
    expect(dispatcher.interactionAgentIds()).toEqual([agent]);
    expect(dispatcher.pushJobLogsRequest(agent, "log", "scheduler", 10, "job", false)).toBe(true);
    const channel = dispatcher.interactionChannel(agent);
    if (!channel) throw new Error("Missing remote route");
    channel.push(
      create(ServerMessageSchema, { payload: { case: "sftpOpen", value: { sessionId: "file" } } }),
    );
    for (const value of [0, 255, 10])
      channel.push(
        create(ServerMessageSchema, {
          payload: { case: "sshData", value: { sessionId: "file", data: Uint8Array.of(value) } },
        }),
      );
    await until(() => received.length === 4);
    expect(
      received.flatMap(({ payload: p }) => (p.case === "sshOutput" ? [...p.value.data] : [])),
    ).toEqual([0, 255, 10]);
    expect(
      received.some(
        ({ payload: p }) => p.case === "jobLogsResponse" && p.value.text === "owner logs",
      ),
    ).toBe(true);
    await sessions.claim(agent, crypto.randomUUID(), {
      schedulerLimits: false,
      pinnedSpack: false,
    });
    await relay.refresh();
    expect(dispatcher.interactionChannel(agent)).toBeUndefined();
    await until(() => commands.includes("sshClose"));
    expect(received.at(-1)?.payload.case).toBe("sshClosed");
  } finally {
    relay?.stop();
    peer.kill();
    await peer.exited;
    await db.delete(agents).where(eq(agents.agentId, agent));
    await db.$client.end();
  }
});
