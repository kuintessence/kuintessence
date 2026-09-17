// Composition-root factory for the metering repository.
//
// The Server bootstrap can call this once at startup with the live PG
// handle to obtain the Drizzle-backed repo. Tests and the CLI dev mode
// call it without a `db` to fall back to the in-memory variant — that
// preserves the behavior the test suite already depends on without any
// fork.
//
// We deliberately keep this a small helper instead of a DI container:
// every other service in the Server uses the same plain-constructor +
// composition-root pattern, and adding a container just for one
// repository would be unnecessary indirection.

import type { PgDb } from "@kuintessence/db";
import { InMemoryMeteringRepository, type MeteringRepository } from "./metering";
import { DrizzleMeteringRepository } from "./metering-repository-drizzle";

export interface MeteringRepositoryFactoryDeps {
  /**
   * Live Drizzle PG handle. When omitted the factory returns the
   * in-memory variant — useful for tests and ephemeral CLI runs.
   */
  db?: PgDb;
}

export function makeMeteringRepository(deps: MeteringRepositoryFactoryDeps): MeteringRepository {
  if (deps.db) {
    return new DrizzleMeteringRepository(deps.db);
  }
  return new InMemoryMeteringRepository();
}
