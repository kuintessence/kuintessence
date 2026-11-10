import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import * as schemaFederation from "./schema-federation";
import * as schemaMetering from "./schema-metering";
import * as schemaSpackMaterials from "./schema-spack-materials";

import * as schemaWorkflowExecution from "./schema-workflow-execution";

type FullSchema = typeof schema &
  typeof schemaMetering &
  typeof schemaSpackMaterials &
  typeof schemaFederation &
  typeof schemaWorkflowExecution;

const fullSchema: FullSchema = {
  ...schema,
  ...schemaMetering,
  ...schemaSpackMaterials,
  ...schemaFederation,
  ...schemaWorkflowExecution,
};

export type PgConnectionOptions = Pick<
  postgres.Options<Record<string, postgres.PostgresType>>,
  "max" | "idle_timeout"
>;

export type PgDb = PostgresJsDatabase<FullSchema> & { $client: postgres.Sql };

export function createPgDb(connectionString: string, options: PgConnectionOptions = {}): PgDb {
  // Legacy timestamp columns are decoded as UTC; SQL defaults must use the same timezone.
  const client = postgres(connectionString, {
    max: 1,
    ...options,
    connection: { TimeZone: "UTC" },
  });
  return drizzle(client, { schema: fullSchema });
}

export type PgTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
