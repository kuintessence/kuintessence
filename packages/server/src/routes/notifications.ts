import { AppError, ErrorCode } from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { NotificationService } from "../services/notifications";
import { isPubliclyRoutableHttpUrl } from "../services/webhook-url-guard";

function recipient(c: Context) {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) throw new AppError(ErrorCode.FORBIDDEN, "User identity required", 403);
  return principal.userId;
}
const preferenceSchema = z.strictObject({
  emailEnabled: z.boolean(),
  webhookUrl: z
    .string()
    .max(2048)
    .url()
    .refine(
      (url) =>
        url.startsWith("https://") &&
        isPubliclyRoutableHttpUrl(url) &&
        !new URL(url).username &&
        !new URL(url).password,
    )
    .nullable(),
  webhookSecret: z.string().min(16).max(256).optional(),
});

export function createNotificationRoutes(service: NotificationService) {
  const r = new Hono();
  r.get("/notifications", async (c) =>
    c.json({
      items: await service.inbox(
        recipient(c),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(2147483647)
          .parse(c.req.query("offset") ?? 0),
      ),
    }),
  );
  r.get("/notifications/preferences", async (c) => c.json(await service.preferences(recipient(c))));
  r.put(
    "/notifications/preferences",
    kqValidator("json", preferenceSchema, "Invalid notification preferences"),
    async (c) => {
      const userId = recipient(c);
      await service.configure(userId, c.req.valid("json"));
      return c.json(await service.preferences(userId));
    },
  );
  r.post("/notifications/:id/read", async (c) => {
    await service.read(recipient(c), z.string().uuid().parse(c.req.param("id")));
    return c.json({ read: true });
  });
  return r;
}
