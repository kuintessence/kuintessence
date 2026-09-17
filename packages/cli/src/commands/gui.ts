import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { EMBEDDED_SPA } from "../gui-serve/embedded-spa";
import { createGuiServer } from "../gui-serve/server";
import { localSchedulerErrorMessage, parseScheduler } from "../lib/local-scheduler";
import { expandTilde, selectBackend } from "../tui/backend/select";

const DEFAULT_GUI_PORT = 8799;
const DEFAULT_GUI_HOST = "127.0.0.1";

/** Validate a `--port` value into a TCP port. Pure + exported for testing. */
export function parseGuiPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${value}". Expected an integer in 1–65535.`);
  }
  return port;
}

/** Best-effort open the system browser at `url`; swallow any failure. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort: a headless host without a browser is fine
  }
}

/**
 * Register the `kq gui` subcommand group.
 *
 * Usage:
 *   kq gui serve --port 8799 [--host 0.0.0.0] [--token T] [--scheduler slurm]
 *
 * `serve` exposes this node's embedded kernel as Server-API-shaped JSON under
 * `/api/*` (via {@link createGuiServer}) so the React SPA can drive the
 * all-in-one node from a browser with no Server.
 */
export function registerGuiCommand(program: Command): void {
  const g = program.command("gui").description("Local GUI operations");

  g.command("serve")
    .description(
      "Serve this node's local scheduler as Server-API-shaped JSON so the React SPA can drive it (no Server)",
    )
    .option("--port <n>", `Listen port (default ${DEFAULT_GUI_PORT})`)
    .option(
      "--host <h>",
      `Bind address (default ${DEFAULT_GUI_HOST}; binding 0.0.0.0 exposes this node to the network)`,
    )
    .option(
      "--token <t>",
      "Bearer token required on every route except /api/auth/* (or set KQ_GUI_TOKEN)",
    )
    .option(
      "--scheduler <type>",
      "Force the scheduler type (slurm|pbs-pro|torque|kubernetes); default auto-detect",
    )
    .option("--data-dir <path>", "Local SQLite store directory (default ~/.kuintessence)")
    .option("--no-db", "Don't persist jobs (ephemeral; default persists)")
    .option(
      "--web-dir <path>",
      "Also serve a built SPA from this dir (e.g. packages/web/dist) for a zero-Tauri browser GUI",
    )
    .option("--open", "Open the served GUI in the default browser after starting")
    .action(
      async (opts: {
        port?: string;
        host?: string;
        token?: string;
        scheduler?: string;
        dataDir?: string;
        db?: boolean;
        webDir?: string;
        open?: boolean;
      }) => {
        // Arg validation runs OUTSIDE the scheduler catch so a bad flag surfaces
        // its own message (via the top-level formatCliError handler) rather than
        // being mislabeled as a missing-scheduler failure.
        const port = opts.port ? parseGuiPort(opts.port) : DEFAULT_GUI_PORT;
        const host = opts.host ?? DEFAULT_GUI_HOST;
        const token = opts.token ?? process.env.KQ_GUI_TOKEN;
        const noDb = opts.db === false;
        const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
        const dbPath = opts.dataDir
          ? join(expandTilde(opts.dataDir, homedir()), "local.db")
          : undefined;

        let backend: Awaited<ReturnType<typeof selectBackend>>;
        try {
          backend = await selectBackend({ local: true, scheduler, dbPath, noDb });
        } catch (err) {
          console.error(
            localSchedulerErrorMessage(
              "gui serve",
              err,
              "or deploy a Server and open the SPA against it (its standard Server-client mode)",
            ),
          );
          process.exit(1);
        }

        const webDir = opts.webDir ? expandTilde(opts.webDir, homedir()) : undefined;
        const hasEmbedded = !webDir && Object.keys(EMBEDDED_SPA).length > 0;
        const server = createGuiServer(backend, {
          ...(token ? { token } : {}),
          ...(webDir ? { webDir } : { embeddedSpa: EMBEDDED_SPA }),
        });
        Bun.serve({ port, hostname: host, fetch: server.fetch });

        const url = `http://${host}:${port}`;
        const servesSpa = !!webDir || hasEmbedded;
        console.log(
          `${servesSpa ? "GUI" : "GUI API"} on ${url}${servesSpa ? "/ (serving SPA)" : ""} ` +
            `(scheduler: ${backend.info.target}, auth: ${token ? "on" : "off"})`,
        );
        if (!servesSpa && !webDir) {
          console.log("note: no SPA embedded in this binary; pass --web-dir <packages/web/dist>.");
        }
        if (host === "0.0.0.0" && !token) {
          console.warn(
            "warning: bound to 0.0.0.0 with no --token — this node's scheduler is open to the network.",
          );
        }
        if (opts.open) {
          openBrowser(`${url}/`);
        }
      },
    );
}
