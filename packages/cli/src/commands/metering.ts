// kq metering <query|export|webhook>
//
// Wraps the Server metering endpoints (`/api/metering/*`) for usage queries
// and CSV export. Webhook subcommand manages billing-system
// subscribers (ORG_ADMIN+).

import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";

interface QueryResultRow {
  groupKey: string;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  jobCount: number;
}

interface QueryResp {
  total: number;
  rows: QueryResultRow[];
}

export function registerMeteringCommand(program: Command): void {
  const m = program.command("metering").description("Query and export platform metering data");

  m.command("query")
    .description("Query usage data")
    .requiredOption("--from <iso>", "Window start (ISO 8601)")
    .requiredOption("--to <iso>", "Window end (ISO 8601)")
    .option("--grouping <kind>", "Group by user|org|cluster|app", "user")
    .option("--period <kind>", "Bucket period raw|hourly|daily|monthly", "daily")
    .option("--orgs <ids>", "Comma-separated org ids; super_admin: '*' for global")
    .option("--limit <n>", "Page size", "100")
    .option("--offset <n>", "Page offset", "0")
    .action(
      async (opts: {
        from: string;
        to: string;
        grouping: string;
        period: string;
        orgs?: string;
        limit: string;
        offset: string;
      }) => {
        const client = ApiClient.fromConfig(loadCliConfig());
        const orgIds = opts.orgs
          ? opts.orgs
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const params = new URLSearchParams({
          from: opts.from,
          to: opts.to,
          grouping: opts.grouping,
          period: opts.period,
          limit: opts.limit,
          offset: opts.offset,
        });
        if (orgIds && orgIds.length > 0) params.set("orgIds", orgIds.join(","));
        const r = await client.get<QueryResp>(`/metering/query?${params.toString()}`);
        if (r.rows.length === 0) {
          console.log("No usage data in window.");
          return;
        }
        console.log("GROUP\tCPU_SEC\tGPU_SEC\tMEM_MB_SEC\tSTORE_MB_SEC\tNET_EGRESS_MB\tJOBS");
        for (const row of r.rows) {
          console.log(
            `${row.groupKey}\t${row.cpuCoreSeconds}\t${row.gpuSeconds}\t${row.memoryMbSeconds}\t${row.storageMbSeconds}\t${row.networkEgressMb}\t${row.jobCount}`,
          );
        }
        console.log(`-- ${r.rows.length} rows of ${r.total} (paginated)`);
      },
    );

  m.command("export")
    .description("Export usage data as CSV")
    .requiredOption("--from <iso>", "Window start (ISO 8601)")
    .requiredOption("--to <iso>", "Window end (ISO 8601)")
    .requiredOption("--out <file>", "Output file path")
    .option("--format <kind>", "csv | json | parquet", "csv")
    .option("--grouping <kind>", "Group by user|org|cluster|app", "user")
    .option("--period <kind>", "Bucket period raw|hourly|daily|monthly", "daily")
    .action(
      async (opts: {
        from: string;
        to: string;
        out: string;
        format: string;
        grouping: string;
        period: string;
      }) => {
        const cfg = loadCliConfig();
        const params = new URLSearchParams({
          format: opts.format,
          from: opts.from,
          to: opts.to,
          grouping: opts.grouping,
          period: opts.period,
        });
        const r = await fetch(`${cfg.serverUrl}/api/metering/export?${params.toString()}`, {
          headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        });
        if (!r.ok) {
          console.error(`Export failed: ${r.status} ${r.statusText}`);
          process.exit(1);
        }
        const data = await r.arrayBuffer();
        await writeFile(opts.out, Buffer.from(data));
        console.log(`Wrote ${data.byteLength} bytes to ${opts.out}`);
      },
    );

  const wh = m.command("webhook").description("Manage billing webhooks (ORG_ADMIN+)");
  wh.command("list").action(async () => {
    const client = ApiClient.fromConfig(loadCliConfig());
    const r = await client.get<{ items: unknown[] }>("/metering/webhook");
    console.log(JSON.stringify(r.items, null, 2));
  });
  wh.command("create")
    .requiredOption("--url <url>", "Webhook endpoint URL")
    .requiredOption("--secret <s>", "HMAC signing secret")
    .option(
      "--events <list>",
      "Comma-separated event types (default: usage.daily,usage.monthly)",
      "usage.daily,usage.monthly",
    )
    .action(async (opts: { url: string; secret: string; events: string }) => {
      const client = ApiClient.fromConfig(loadCliConfig());
      const r = await client.post<{ id: string }>("/metering/webhook", {
        url: opts.url,
        secret: opts.secret,
        events: opts.events
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      console.log(`Created webhook id=${r.id}`);
    });
  wh.command("delete <id>").action(async (id: string) => {
    const client = ApiClient.fromConfig(loadCliConfig());
    await client.delete(`/metering/webhook/${id}`);
    console.log(`Deleted webhook ${id}`);
  });
}
