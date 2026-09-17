import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL must be set for drizzle-kit operations");
}

export default defineConfig({
  // Both PG schema modules must be scanned. Omitting schema-metering.ts makes
  // drizzle-kit treat the 5 metering tables as removed and emit a destructive
  // `DROP ... CASCADE` on every generate — they are exported from the db index
  // and live in PG, so they belong in the diff baseline.
  schema: ["./src/pg/schema.ts", "./src/pg/schema-metering.ts"],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
