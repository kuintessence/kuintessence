import type { PgDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { z } from "zod";
import { EventBus } from "./event-bus";

const logger = createLogger("pg-event-bus");
const channel = "kq_server_events";
const eventSchema = z.object({
  origin: z.string().uuid(),
  event: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("job"),
      value: z.object({
        jobId: z.string(),
        status: z.string(),
        agentId: z.string().nullish(),
        schedulerJobId: z.string().nullish(),
      }),
    }),
    z.object({
      kind: z.literal("workflow"),
      value: z.object({
        runId: z.string(),
        stepId: z.string(),
        jobId: z.string(),
        status: z.string(),
      }),
    }),
  ]),
});

export async function createPgEventBus(client: PgDb["$client"]) {
  const origin = crypto.randomUUID();
  let pending = Promise.resolve();
  const bus = new EventBus((event) => {
    const payload = JSON.stringify({ origin, event });
    pending = pending
      .then(async () => {
        await client.notify(channel, payload);
      })
      .catch((err) => logger.error({ err }, "Could not publish status update"));
  });
  const listener = await client.listen(channel, (raw) => {
    try {
      const message = eventSchema.parse(JSON.parse(raw));
      if (message.origin !== origin) bus.receive(message.event);
    } catch {
      logger.warn("Invalid database status update");
    }
  });
  return {
    bus,
    close: async () => {
      await pending;
      await listener.unlisten();
    },
  };
}
