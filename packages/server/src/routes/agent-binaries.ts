import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";

const names = ["kq-agent-bun-linux-x64", "kq-agent-bun-linux-arm64"] as const;
const manifestSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/),
    agentVersion: z.string().min(1),
    bunVersion: z.string().min(1),
    files: z
      .array(
        z
          .object({
            name: z.enum(names),
            target: z.enum(["bun-linux-x64", "bun-linux-arm64"]),
            size: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(2)
      .refine(
        (files) =>
          new Set(files.map((file) => file.name)).size === 2 &&
          files.every((file) => file.name === `kq-agent-${file.target}`),
      ),
  })
  .strict();
const allowedFiles = new Set<string>([...names, "manifest.json", "SHA256SUMS"]);

export function createAgentBinaryRoutes(directory: string) {
  const routes = new Hono();

  routes.get("/agent-binaries", async (c) => {
    const file = Bun.file(join(directory, "manifest.json"));
    if (!(await file.exists())) return c.json({ error: "Agent binaries are not bundled" }, 404);
    const manifest = manifestSchema.parse(await file.json());
    c.header("Cache-Control", "no-store");
    return c.json(manifest);
  });

  routes.on(["GET", "HEAD"], "/agent-binaries/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || !allowedFiles.has(filename))
      return c.json({ error: "Artifact not found" }, 404);
    const manifestFile = Bun.file(join(directory, "manifest.json"));
    if (!(await manifestFile.exists()))
      return c.json({ error: "Agent binaries are not bundled" }, 404);
    const manifest = manifestSchema.parse(await manifestFile.json());
    const revision = c.req.query("revision");
    if (revision !== undefined && revision !== manifest.revision) {
      return c.json({ error: "Server revision changed; fetch the Agent manifest again" }, 409);
    }
    const file = Bun.file(join(directory, filename));
    if (!(await file.exists())) return c.json({ error: "Artifact not found" }, 404);
    const artifact = manifest.files.find((entry) => entry.name === filename);
    if (artifact && artifact.size !== file.size) throw new Error("Bundled Agent size mismatch");
    const headers = new Headers({
      "Content-Type":
        filename === "manifest.json"
          ? "application/json"
          : filename === "SHA256SUMS"
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Kuintessence-Revision": manifest.revision,
      "X-Content-Type-Options": "nosniff",
    });
    if (artifact) headers.set("ETag", `"${artifact.sha256}"`);
    return new Response(c.req.method === "HEAD" ? null : file, { headers });
  });

  return routes;
}
