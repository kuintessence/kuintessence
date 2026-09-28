import { createLogger } from "../../packages/shared/src/utils/logger";
import type { SeedMode } from "./catalog";
import { seedDatabase, type SeedStore } from "./seed";
import { connectSeedStore } from "./store";

type Environment = Readonly<Record<string, string | undefined>>;
type Connection = SeedStore & { close(): Promise<void> };
interface SeedLogger {
  info(message: string): void;
  error(message: string): void;
}

export function readSeedConfig(env: Environment): { databaseUrl: string; mode: SeedMode } {
  const mode = env.SEED_MODE ?? "minimal";
  if (mode !== "minimal" && mode !== "demo") throw new Error("Invalid SEED_MODE");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.hash
  ) {
    throw new Error("Invalid DATABASE_URL");
  }
  return { databaseUrl, mode };
}

export async function runSeedCommand(
  env: Environment,
  logger: SeedLogger,
  connect: (url: string) => Connection = connectSeedStore,
): Promise<0 | 1> {
  try {
    const config = readSeedConfig(env);
    const connection = connect(config.databaseUrl);
    let result: Awaited<ReturnType<typeof seedDatabase>>;
    try {
      result = await seedDatabase(connection, config.mode);
    } finally {
      await connection.close();
    }
    logger.info(result === "applied" ? "KQ_SEED_APPLIED" : "KQ_SEED_ALREADY_APPLIED");
    return 0;
  } catch {
    // SQL errors may contain DATABASE_URL, credentials or full row values.
    logger.error("KQ_SEED_FAILED");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runSeedCommand(process.env, createLogger("deployment-seed", "info"));
}
