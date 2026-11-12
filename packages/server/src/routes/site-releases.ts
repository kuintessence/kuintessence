import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const siteReleaseSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    serverRevision: z.string().regex(/^[a-f0-9]{40}$/),
    stateFormat: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    architecture: z.enum(["x86_64", "aarch64"]),
    minGlibc: z.string().regex(/^\d+\.\d+$/),
    cpuFlags: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(128),
    redistribution: z.literal("unrestricted"),
    files: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
            role: z.enum(["agent", "cli", "runtime-sif", "site-profile", "spack", "tool"]),
            size: z
              .number()
              .int()
              .positive()
              .max(512 * 1024 ** 3),
            sha256: digest,
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(128),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length ||
      manifest.files.some(
        (f) =>
          ["manifest.json", "manifest.sig", "agent.env"].includes(f.name) ||
          ((f.role === "agent" || f.role === "cli" || f.role === "spack") && !f.executable),
      ) ||
      ["agent", "cli"].some((role) => manifest.files.filter((f) => f.role === role).length !== 1) ||
      ["runtime-sif", "site-profile", "spack"].some(
        (role) => manifest.files.filter((f) => f.role === role).length > 1,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate or missing site release artifacts" });
    }
  });

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
      const id = digest.parse((await readFile(pointer.path, "utf8")).trim());
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
    if (!digest.safeParse(id).success) return c.notFound();
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
