import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL must be set for drizzle-kit operations");
}

export default defineConfig({
  // Scan every Server PG schema module so generation preserves existing tables
  // and includes the persistent Spack material reference ledger.
  schema: [
    "./src/pg/schema.ts",
    "./src/pg/schema-metering.ts",
    "./src/pg/schema-spack-materials.ts",
  ],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
