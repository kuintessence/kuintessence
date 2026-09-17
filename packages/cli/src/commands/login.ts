// `kq login` — supports two flows:
//
// 1. Default: OIDC browser flow (the production path). Spins up a local
//    HTTP listener, opens the user's browser to the Server OIDC route,
//    captures the redirect, exchanges the code for a token.
// 2. `--email` flag: legacy dev-mode email-based login (kept for fixtures
//    and CI tests; matches the original behavior).

import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig, saveCliConfig } from "../lib/config";
import { runOidcBrowserFlow } from "../lib/oidc-browser-flow";

interface LegacyLoginResponse {
  token: string;
  expiresIn: number;
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with Server (default: OIDC browser flow)")
    .option("-u, --url <url>", "Server URL (default: from config)")
    .option("--server <url>", "Server URL (alias for --url)")
    .option("-e, --email <email>", "Dev-mode email login (skips OIDC)")
    .option("-r, --role <role>", "Dev-mode role override", "user")
    .action(async (opts: { url?: string; server?: string; email?: string; role: string }) => {
      const baseConfig = loadCliConfig();
      const serverUrl = opts.url ?? opts.server ?? baseConfig.serverUrl;

      if (opts.email) {
        const client = new ApiClient(serverUrl);
        const result = await client.post<LegacyLoginResponse>("/auth/login", {
          email: opts.email,
          role: opts.role,
        });
        saveCliConfig({ ...baseConfig, serverUrl, token: result.token });
        console.log(`Logged in as ${opts.email} (role: ${opts.role}, dev mode).`);
        console.log(`Token expires in ${result.expiresIn}s.`);
        return;
      }

      console.log("Opening browser for SSO sign-in…");
      const r = await runOidcBrowserFlow(serverUrl);
      saveCliConfig({ ...baseConfig, serverUrl, token: r.accessToken, expiresAt: r.expiresAt });
      const subj = r.principal?.email ?? r.principal?.sub ?? "(unknown)";
      console.log(`Logged in as ${subj}${r.expiresAt ? ` (token expires ${r.expiresAt})` : ""}.`);
    });

  program
    .command("logout")
    .description("Revoke the active CLI session and remove local credentials")
    .action(async () => {
      const config = loadCliConfig();
      if (config.token) {
        await ApiClient.fromConfig(config).post("/auth/logout", {});
      }
      saveCliConfig({ serverUrl: config.serverUrl });
      console.log("Logged out.");
    });
}
