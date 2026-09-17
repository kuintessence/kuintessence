// kq software <list|show|publish|install|lock|unlock|policy>
//
// Wraps the Server software-governance endpoints and the Registry
// registry endpoints. Designed for CP/admin use.

import { readFile } from "node:fs/promises";
import type { SpackManager } from "@kuintessence/agent/embedded";
import type { Command } from "commander";
import { z } from "zod";
import { ApiClient } from "../lib/api-client";
import { type CliConfig, loadCliConfig } from "../lib/config";
import {
  formatExportOutcome,
  formatImportResult,
  formatInstalledTable,
  formatInstallOutcome,
  formatMirrorList,
  LOCAL_POLICY,
  localSpack,
  localSpackErrorMessage,
} from "../lib/local-spack";

/** Guard a local-only subcommand: mirror/buildcache have no Server endpoint yet. */
export function requireLocal(command: string, local: boolean | undefined): void {
  if (!local) {
    console.error(`kq software ${command}: only --local is supported (no Server endpoint yet)`);
    process.exit(1);
  }
}

/**
 * Run a `--local` software action against the embedded `SpackManager` and
 * print the outcome. Bootstraps spack (friendly error + exit 1 if absent),
 * then exits 1 when the action's outcome is a failure. `provideManager` is an
 * injection seam: unit tests pass a manager backed by a mock `Spawner` so no
 * real spack is needed.
 */
export async function runLocal(
  command: string,
  action: (manager: SpackManager) => Promise<{ text: string; ok: boolean }>,
  provideManager: () => Promise<SpackManager> = () => localSpack(),
): Promise<void> {
  let manager: SpackManager;
  try {
    manager = await provideManager();
  } catch (err) {
    console.error(localSpackErrorMessage(command, err));
    process.exit(1);
  }
  try {
    const { text, ok } = await action(manager);
    if (ok) {
      console.log(text);
    } else {
      console.error(text);
      process.exit(1);
    }
  } catch (err) {
    console.error(localSpackErrorMessage(command, err));
    process.exit(1);
  }
}

interface SoftwareItem {
  namespace: string;
  name: string;
  version: string;
  spec: string;
  locked: boolean;
  status: "available" | "installing" | "blacklisted" | "removed";
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const RemoteCatalogSourceSchema = z.enum(["upstream", "official", "vendor"]);
type RemoteCatalogSource = z.infer<typeof RemoteCatalogSourceSchema>;
const RemoteCatalogPackageSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    source: RemoteCatalogSourceSchema,
    metadata: z
      .object({
        versions: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    asset: z
      .object({
        lifecycle: z.string(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const RemoteCatalogPageSchema = z
  .object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    packages: z.array(RemoteCatalogPackageSchema),
  })
  .passthrough()
  .refine(
    (page) =>
      new Set(page.packages.map((item) => item.id ?? `catalog:${item.source}:${item.name}`))
        .size === page.packages.length,
    { message: "catalog package ids must be unique" },
  );
type RemoteCatalogPage = z.infer<typeof RemoteCatalogPageSchema>;

export function resolveRegistryApiBase(
  serverUrl: string,
  configuredUrl = process.env.KQ_REGISTRY_URL,
): string {
  const configured = configuredUrl?.trim();
  if (configured) {
    const url = new URL(configured);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !loopback) {
      throw new Error("KQ_REGISTRY_URL must use HTTPS outside loopback development");
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path.endsWith("/api") ? path : `${path}/api`}`;
  }
  return new URL("/software/api", serverUrl).toString().replace(/\/+$/, "");
}

export async function fetchRemoteSoftwareCatalog(
  config: CliConfig,
  filters: { page?: number; pageSize?: number; query?: string; source?: RemoteCatalogSource } = {},
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): Promise<RemoteCatalogPage> {
  const params = new URLSearchParams({
    page: String(filters.page ?? 1),
    pageSize: String(filters.pageSize ?? 24),
  });
  if (filters.query) params.set("q", filters.query);
  if (filters.source) params.set("source", filters.source);
  const response = await fetchFn(
    `${resolveRegistryApiBase(config.serverUrl)}/spack/catalog?${params.toString()}`,
    { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} },
  );
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Registry catalog returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = RemoteCatalogPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Registry catalog returned an invalid response");
  }
  return parsed.data;
}

export function parseRemoteCatalogSource(
  value: string | undefined,
): RemoteCatalogSource | undefined {
  if (!value) return undefined;
  const parsed = RemoteCatalogSourceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error("--source must be upstream, official, or vendor");
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

export function formatRemoteSoftwareCatalog(page: RemoteCatalogPage): string {
  if (page.packages.length === 0) return "No software found.";
  const rows = ["SOURCE\tNAME\tVERSION\tLIFECYCLE"];
  for (const item of page.packages) {
    rows.push(
      [
        item.source,
        item.name,
        item.metadata?.versions?.[0] ?? "-",
        item.asset?.lifecycle ?? "catalog",
      ].join("\t"),
    );
  }
  rows.push(
    `Showing ${page.packages.length} of ${page.totalCount} (page ${page.page}/${page.totalPages})`,
  );
  return rows.join("\n");
}

export function registerSoftwareCommand(program: Command): void {
  const sw = program.command("software").description("Manage software policies and templates");

  sw.command("list")
    .description("List the Registry Spack catalog")
    .option("--source <source>", "Filter by source (upstream|official|vendor)")
    .option("--query <text>", "Filter by package name")
    .option("--page <n>", "Catalog page", "1")
    .option("--page-size <n>", "Packages per page (maximum 100)", "24")
    .option("--local", "All-in-one mode: list the local Spack installed-list directly, no Server")
    .action(
      async (opts: {
        source?: string;
        query?: string;
        page: string;
        pageSize: string;
        local?: boolean;
      }) => {
        if (opts.local) {
          await runLocal("list", async (manager) => ({
            text: formatInstalledTable(await manager.installedList()),
            ok: true,
          }));
          return;
        }
        const source = parseRemoteCatalogSource(opts.source);
        console.log(
          formatRemoteSoftwareCatalog(
            await fetchRemoteSoftwareCatalog(loadCliConfig(), {
              page: parsePositiveInteger(opts.page, "--page"),
              pageSize: parsePositiveInteger(opts.pageSize, "--page-size"),
              ...(opts.query ? { query: opts.query } : {}),
              ...(source ? { source } : {}),
            }),
          ),
        );
      },
    );

  sw.command("show <repo>")
    .description("Show details of a specific software repository (namespace/name)")
    .action(async (repo: string) => {
      const client = ApiClient.fromConfig(loadCliConfig());
      const r = await client.get<{ item: SoftwareItem }>(`/software/${encodeURIComponent(repo)}`);
      console.log(JSON.stringify(r.item, null, 2));
    });

  sw.command("publish <yaml-file>")
    .description("Publish an application or workflow template from YAML")
    .requiredOption("--namespace <ns>", "Target namespace (org/<orgId> or user/<userId>)")
    .option("--tag <tag>", "Semver tag (immutable). Defaults to metadata.version")
    .action(async (yamlPath: string, opts: { namespace: string; tag?: string }) => {
      const body = await readFile(yamlPath, "utf-8");
      const client = ApiClient.fromConfig(loadCliConfig());
      const r = await client.post<{ id: string; tag: string; digest: string }>(
        "/software/publish",
        { namespace: opts.namespace, yaml: body, tag: opts.tag ?? null },
      );
      console.log(
        `Published: namespace=${opts.namespace} tag=${r.tag} digest=${r.digest} id=${r.id}`,
      );
    });

  sw.command("install <repo>")
    .description("Request installation of a software template (subject to policy)")
    .option("--cluster <name>", "Target cluster (required without --local)")
    .option(
      "--local",
      "All-in-one mode: `spack install` directly against the local Spack, no Server",
    )
    .action(async (repo: string, opts: { cluster?: string; local?: boolean }) => {
      if (opts.local) {
        await runLocal("install", async (manager) =>
          formatInstallOutcome(repo, await manager.requestInstall(repo, LOCAL_POLICY)),
        );
        return;
      }
      if (!opts.cluster) {
        console.error("kq software install: --cluster is required without --local");
        process.exit(1);
      }
      const client = ApiClient.fromConfig(loadCliConfig());
      const r = await client.post<{ requestId: string; status: string }>("/software/install", {
        repo,
        cluster: opts.cluster,
      });
      console.log(`Install request submitted: id=${r.requestId} status=${r.status}`);
    });

  const mirror = sw.command("mirror").description("Manage Spack mirrors (all-in-one --local)");
  mirror
    .command("list")
    .description("List configured Spack mirrors")
    .option("--local", "All-in-one mode: read the local Spack mirror config, no Server")
    .action(async (opts: { local?: boolean }) => {
      requireLocal("mirror list", opts.local);
      await runLocal("mirror list", async (manager) => {
        const mgr = manager.mirrorManager;
        if (!mgr) throw new Error("spack mirror manager is unavailable");
        return { text: formatMirrorList(await mgr.list()), ok: true };
      });
    });
  mirror
    .command("add <name> <url>")
    .description("Register a Spack mirror")
    .option("--local", "All-in-one mode: `spack mirror add` against the local Spack, no Server")
    .action(async (name: string, url: string, opts: { local?: boolean }) => {
      requireLocal("mirror add", opts.local);
      await runLocal("mirror add", async (manager) => {
        const mgr = manager.mirrorManager;
        if (!mgr) throw new Error("spack mirror manager is unavailable");
        await mgr.add(name, url);
        return { text: `Added mirror ${name} -> ${url}.`, ok: true };
      });
    });
  mirror
    .command("rm <name>")
    .description("Deregister a Spack mirror")
    .option("--local", "All-in-one mode: `spack mirror rm` against the local Spack, no Server")
    .action(async (name: string, opts: { local?: boolean }) => {
      requireLocal("mirror rm", opts.local);
      await runLocal("mirror rm", async (manager) => {
        const mgr = manager.mirrorManager;
        if (!mgr) throw new Error("spack mirror manager is unavailable");
        await mgr.remove(name);
        return { text: `Removed mirror ${name}.`, ok: true };
      });
    });

  const buildcache = sw
    .command("buildcache")
    .description("Manage Spack buildcache (all-in-one --local)");
  buildcache
    .command("install <specs...>")
    .description("Install one or more specs from a buildcache")
    .option(
      "--local",
      "All-in-one mode: `spack buildcache install` against the local Spack, no Server",
    )
    .action(async (specs: string[], opts: { local?: boolean }) => {
      requireLocal("buildcache install", opts.local);
      await runLocal("buildcache install", async (manager) =>
        formatImportResult(await manager.importBuildcache(specs)),
      );
    });
  buildcache
    .command("push <spec> <mirror>")
    .description("Push a locally-built spec to a buildcache mirror")
    .option(
      "--local",
      "All-in-one mode: `spack buildcache push` against the local Spack, no Server",
    )
    .action(async (spec: string, mirror: string, opts: { local?: boolean }) => {
      requireLocal("buildcache push", opts.local);
      await runLocal("buildcache push", async (manager) =>
        formatExportOutcome(spec, mirror, await manager.exportBuildcache(spec, mirror)),
      );
    });

  sw.command("lock <repo>")
    .description("Lock a software version on a cluster (prevents replacement)")
    .requiredOption("--cluster <name>", "Target cluster")
    .action(async (repo: string, opts: { cluster: string }) => {
      const client = ApiClient.fromConfig(loadCliConfig());
      await client.post(`/software/lock`, { repo, cluster: opts.cluster });
      console.log(`Locked ${repo} on ${opts.cluster}`);
    });

  sw.command("unlock <repo>")
    .description("Unlock a software version on a cluster")
    .requiredOption("--cluster <name>", "Target cluster")
    .action(async (repo: string, opts: { cluster: string }) => {
      const client = ApiClient.fromConfig(loadCliConfig());
      await client.post(`/software/unlock`, { repo, cluster: opts.cluster });
      console.log(`Unlocked ${repo} on ${opts.cluster}`);
    });

  const policy = sw.command("policy").description("Manage cluster software policy (CP/admin)");
  policy
    .command("list")
    .requiredOption("--cluster <name>", "Cluster")
    .action(async (opts: { cluster: string }) => {
      const client = ApiClient.fromConfig(loadCliConfig());
      const r = await client.get(`/software/policy?cluster=${encodeURIComponent(opts.cluster)}`);
      console.log(JSON.stringify(r, null, 2));
    });
  policy
    .command("set")
    .requiredOption("--cluster <name>", "Cluster")
    .requiredOption("--list <type>", "whitelist | blacklist")
    .requiredOption("--specs <comma-separated>", "Spack specs to allow/deny")
    .action(async (opts: { cluster: string; list: string; specs: string }) => {
      if (opts.list !== "whitelist" && opts.list !== "blacklist") {
        console.error("--list must be whitelist or blacklist");
        process.exit(1);
      }
      const client = ApiClient.fromConfig(loadCliConfig());
      const specs = opts.specs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await client.post(`/software/policy`, {
        cluster: opts.cluster,
        list: opts.list,
        specs,
      });
      console.log(`Updated ${opts.list} for ${opts.cluster} (${specs.length} specs)`);
    });
}
