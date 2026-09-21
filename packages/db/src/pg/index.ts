import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import * as schemaMetering from "./schema-metering";
import * as schemaSpackMaterials from "./schema-spack-materials";

const fullSchema = { ...schema, ...schemaMetering, ...schemaSpackMaterials };

export type PgConnectionOptions = Pick<
  postgres.Options<Record<string, postgres.PostgresType>>,
  "max" | "idle_timeout"
>;

export function createPgDb(connectionString: string, options: PgConnectionOptions = {}) {
  const client = postgres(connectionString, { max: 1, ...options });
  return drizzle(client, { schema: fullSchema });
}

export type PgDb = ReturnType<typeof createPgDb>;
