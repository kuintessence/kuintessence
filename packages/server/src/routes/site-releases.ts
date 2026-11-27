import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { siteReleaseDigestSchema, siteReleaseSchema } from "@kuintessence/shared";
import { Hono } from "hono";

export { siteReleaseSchema } from "@kuintessence/shared";

export function createSiteReleaseRoutes(directory: string) {
  const routes = new Hono();
  async function regular(...parts: string[]) {
    const root = await realpath(directory);
    const path = resolve(join(root, ...parts));
    if (!path.startsWith(`${root}${sep}`) || (await realpath(path)) !== path)
      throw new Error("Invalid site release path");
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("Invalid site release file");
    return { path, stat };
  }
  async function manifest(id: string) {
    const file = await regular("releases", id, "manifest.json");
    if (file.stat.size > 128 * 1024) throw new Error("Site manifest too large");
    const bytes = await readFile(file.path);
    if (createHash("sha256").update(bytes).digest("hex") !== id)
      throw new Error("Site manifest digest mismatch");
    return { bytes, value: siteReleaseSchema.parse(JSON.parse(bytes.toString("utf8"))) };
  }
  routes.get("/site-releases/:channel/manifest.json", async (c) => {
    const channel = c.req.param("channel");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(channel)) return c.notFound();
    try {
      const pointer = await regular("channels", channel);
      if (pointer.stat.size > 65) throw new Error("Invalid release channel");
      const id = siteReleaseDigestSchema.parse((await readFile(pointer.path, "utf8")).trim());
      const release = await manifest(id);
      return new Response(release.bytes, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return c.notFound();
      throw error;
    }
  });
  routes.on(["GET", "HEAD"], "/site-releases/releases/:digest/:name", async (c) => {
    const id = c.req.param("digest");
    const name = c.req.param("name");
    if (!siteReleaseDigestSchema.safeParse(id).success) return c.notFound();
    const release = await manifest(id);
    const artifact = release.value.files.find((file) => file.name === name);
    if (!artifact && name !== "manifest.json" && name !== "manifest.sig") return c.notFound();
    const { path, stat } = await regular("releases", id, name);
    if (artifact && artifact.size !== stat.size) throw new Error("Site artifact size mismatch");
    if (name === "manifest.sig" && stat.size !== 64)
      throw new Error("Invalid Ed25519 signature length");
    const etag = `"${artifact?.sha256 ?? id}"`;
    let start = 0;
    const range =
      !c.req.header("If-Range") || c.req.header("If-Range") === etag
        ? c.req.header("Range")
        : undefined;
    if (range) {
      const match = /^bytes=(0|[1-9][0-9]*)-$/.exec(range);
      if (!match || !Number.isSafeInteger(Number(match[1])))
        return c.json({ error: "Only open-ended byte ranges are supported" }, 400);
      start = Number(match[1]);
      if (start >= stat.size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${stat.size}` },
        });
    }
    return new Response(c.req.method === "HEAD" ? null : Bun.file(path).slice(start), {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size - start),
        ETag: etag,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${stat.size - 1}/${stat.size}` } : {}),
      },
    });
  });
  return routes;
}
