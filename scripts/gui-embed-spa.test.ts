import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEmbeddedSpaModule } from "./gui-embed-spa";

describe("generateEmbeddedSpaModule", () => {
  it("emits an EMBEDDED_SPA map with base64 + mime for every file under dist", async () => {
    const dist = mkdtempSync(join(tmpdir(), "kq-embed-dist-"));
    try {
      writeFileSync(join(dist, "index.html"), "<html><head></head><body>app</body></html>");
      mkdirSync(join(dist, "assets"));
      writeFileSync(join(dist, "assets", "x.js"), "console.log(1)");

      const source = await generateEmbeddedSpaModule(dist);

      // Evaluate the generated module to inspect its exported map.
      const mod = (await import(
        `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`
      )) as { EMBEDDED_SPA: Record<string, { type: string; base64: string }> };
      const map = mod.EMBEDDED_SPA;

      expect(Object.keys(map).sort()).toEqual(["assets/x.js", "index.html"]);
      expect(map["index.html"]?.type).toContain("text/html");
      expect(map["assets/x.js"]?.type).toContain("javascript");

      const indexBase64 = map["index.html"]?.base64 ?? "";
      const jsBase64 = map["assets/x.js"]?.base64 ?? "";
      expect(atob(indexBase64)).toBe("<html><head></head><body>app</body></html>");
      expect(atob(jsBase64)).toBe("console.log(1)");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
