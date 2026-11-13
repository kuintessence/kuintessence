import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { withPrivateUnixSocketStartup } from "./unix-socket";

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Missing socket path");
try {
  await withPrivateUnixSocketStartup(path, async () => {
    if (mode === "hold") {
      setInterval(() => {}, 1000);
      process.stdout.write("locked\n");
      await new Promise(() => {});
    }
    const server = createServer((_request, response) => response.end("ready"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    process.once("SIGTERM", () => server.close());
  });
  process.stdout.write("ready\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Startup failed"}\n`);
  process.exitCode = 1;
}
