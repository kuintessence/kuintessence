import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SiteOperations, SiteOperationsSchema } from "@kuintessence/shared";

/** Only the bounded update status crosses the control stream, never local paths or errors. */
export async function readSiteUpdate(dbPath: string): Promise<SiteOperations["update"]> {
  try {
    const handle = await open(
      join(dirname(dbPath), "..", "status.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 8192 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        return { phase: "unknown" };
      const raw: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!raw || typeof raw !== "object") return { phase: "unknown" };
      const value = raw as Record<string, unknown>;
      return SiteOperationsSchema.shape.update.parse({
        phase: value.phase,
        checkedAt: typeof value.time === "number" ? value.time * 1000 : undefined,
        release: typeof value.release === "string" ? value.release : undefined,
      });
    } finally {
      await handle.close();
    }
  } catch {
    return { phase: "unknown" };
  }
}
