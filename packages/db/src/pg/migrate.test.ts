import { describe, expect, test } from "bun:test";
import {
  AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG,
  AUTHORIZATION_SUBJECTS_0048_MIGRATION_TAG,
  AuthorizationSubject0047PreflightError,
  DATA_DELIVERY_0046_MIGRATION_TAG,
  DATA_MARKET_0043_MIGRATION_TAG,
  DataMarket0043PreflightError,
  loadPgMigrationFiles,
  type PgMigrationFile,
  type PgMigrationRunnerPort,
  type PgMigrationTransaction,
  runPgMigrations,
} from "./migrate";

interface MemoryAuthorizationSubject {
  bindingId: string;
  userId: string | null;
  organizationId: string | null;
  source: "data-market" | "netdrive";
  status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
  subjects: unknown[];
}

type MemoryAuthorizationSubjectInput = Omit<MemoryAuthorizationSubject, "source" | "status"> &
  Partial<Pick<MemoryAuthorizationSubject, "source" | "status">>;

class MemoryMigrationTransaction implements PgMigrationTransaction {
  readonly events: string[] = [];
  readonly recordedMigrations: string[] = [];
  stagePaths: Array<{ id: string; stagePath: string }> = [];
  staleReplicaCount = 0;
  readonly revocationEpochs: Array<number | null>;
  hasAuthorizationSubjectColumn: boolean;
  terminalAuthorizationSubjectHistory: Array<{
    bindingId: string;
    status: "completed" | "failed" | "cancelled";
  }> = [];
  authorizationSubjects: MemoryAuthorizationSubject[];

  constructor(
    private readonly latestAppliedMillis: number | null,
    private readonly bindings: Array<{ id: string; jobId: string; inputDescriptor: string }>,
    options: {
      revocationEpochs?: Array<number | null>;
      hasAuthorizationSubjectColumn?: boolean;
      authorizationSubjects?: MemoryAuthorizationSubjectInput[];
    } = {},
  ) {
    this.revocationEpochs = [...(options.revocationEpochs ?? [])];
    this.hasAuthorizationSubjectColumn = options.hasAuthorizationSubjectColumn ?? true;
    this.authorizationSubjects = (options.authorizationSubjects ?? []).map(
      ({ source = "data-market", status = "completed", ...row }) => ({
        ...row,
        source,
        status,
        subjects: [...row.subjects],
      }),
    );
  }

  async acquireMigrationLock(): Promise<void> {
    this.events.push("lock-migrations");
  }

  async ensureMigrationJournal(): Promise<void> {
    this.events.push("journal");
  }

  async getLatestAppliedMigrationMillis(): Promise<number | null> {
    return this.latestAppliedMillis;
  }

  async lockDataMarket0043Rows(): Promise<void> {
    this.events.push("lock-0043");
  }

  async lockDataDelivery0046Rows(): Promise<void> {
    this.events.push("lock-0046");
  }

  async addDataDeliveryRevocationEpochNullable(): Promise<void> {
    this.events.push("add-revoked-epoch-nullable");
  }

  async backfillDataDeliveryRevocationEpoch(): Promise<number> {
    this.events.push("backfill-revoked-epoch");
    let updated = 0;
    for (let index = 0; index < this.revocationEpochs.length; index += 1) {
      if (this.revocationEpochs[index] === null) {
        this.revocationEpochs[index] = 0;
        updated += 1;
      }
    }
    return updated;
  }

  async finalizeDataDeliveryRevocationEpoch(): Promise<void> {
    this.events.push("finalize-revoked-epoch-not-null-default");
    if (this.revocationEpochs.some((epoch) => epoch === null)) {
      throw new Error("revoked epoch finalization encountered a NULL value");
    }
  }

  async lockAuthorizationSubjectRows(): Promise<void> {
    this.events.push("lock-0047");
  }

  async canonicalizeAuthorizationSubjects() {
    this.events.push("canonicalize-authorization-subjects");
    const blockers: Array<{ bindingId: string; subjectId: string | null }> = [];
    const terminalHistory = this.authorizationSubjects.flatMap((row) => {
      const hasProvableSubject = row.userId !== null || row.organizationId !== null;
      if (
        row.source === "data-market" &&
        row.subjects.length === 0 &&
        !hasProvableSubject &&
        (row.status === "completed" || row.status === "failed" || row.status === "cancelled")
      ) {
        return [{ bindingId: row.bindingId, status: row.status }];
      }
      return [];
    });
    const normalized = this.authorizationSubjects.map((row) => {
      if (row.source === "data-market" && row.subjects.length === 0) {
        const subjects = [
          ...(row.userId ? [`user:${row.userId}`] : []),
          ...(row.organizationId ? [`organization:${row.organizationId}`] : []),
        ];
        if (subjects.length === 0 && ["pending", "queued", "running"].includes(row.status)) {
          blockers.push({ bindingId: row.bindingId, subjectId: null });
        }
        return { ...row, subjects };
      }

      const subjects = row.subjects.map((subject) => {
        if (typeof subject !== "string") {
          blockers.push({ bindingId: row.bindingId, subjectId: null });
          return subject;
        }
        if (subject.startsWith("user:") || subject.startsWith("organization:")) return subject;
        const matchesUser = row.userId !== null && subject === row.userId;
        const matchesOrganization = row.organizationId !== null && subject === row.organizationId;
        if (matchesUser === matchesOrganization) {
          blockers.push({ bindingId: row.bindingId, subjectId: subject });
          return subject;
        }
        return matchesUser ? `user:${subject}` : `organization:${subject}`;
      });
      const hasBareSubject = row.subjects.some(
        (subject) =>
          typeof subject === "string" &&
          !subject.startsWith("user:") &&
          !subject.startsWith("organization:"),
      );
      return {
        ...row,
        subjects: hasBareSubject
          ? subjects.filter((subject, index) => subjects.indexOf(subject) === index)
          : subjects,
      };
    });
    if (blockers.length > 0) return { converted: 0, blockers, terminalHistory: [] };
    const converted = normalized.filter(
      (row, index) =>
        JSON.stringify(row.subjects) !==
        JSON.stringify(this.authorizationSubjects[index]?.subjects),
    ).length;
    this.authorizationSubjects = normalized;
    this.terminalAuthorizationSubjectHistory = terminalHistory;
    return { converted, blockers: [], terminalHistory };
  }

  async markAvailableReplicasStale(): Promise<number> {
    this.events.push("stale-replicas");
    this.staleReplicaCount += 1;
    return 2;
  }

  async listBindingsForStagePathPreflight() {
    this.events.push("preflight-bindings");
    return this.bindings;
  }

  async listBindingsMissingStagePath() {
    return this.bindings;
  }

  async setStagePaths(bindings: readonly { id: string; stagePath: string }[]): Promise<void> {
    this.events.push("backfill-stage-paths");
    this.stagePaths = [...bindings];
  }

  async executeMigrationStatement(statement: string): Promise<void> {
    this.events.push(`sql:${statement}`);
    if (
      statement.trim() ===
      'ALTER TABLE "job_data_bindings" ADD COLUMN "authorization_subject_ids" jsonb DEFAULT \'[]\'::jsonb NOT NULL;'
    ) {
      this.hasAuthorizationSubjectColumn = true;
      this.authorizationSubjects = this.authorizationSubjects.map((row) => ({
        ...row,
        subjects: [],
      }));
    }
  }

  async recordMigration(migration: PgMigrationFile): Promise<void> {
    this.events.push(`record:${migration.tag}`);
    this.recordedMigrations.push(migration.tag);
  }
}

class MemoryMigrationRunner implements PgMigrationRunnerPort {
  constructor(readonly transactionState: MemoryMigrationTransaction) {}

  async transaction(
    callback: (transaction: PgMigrationTransaction) => Promise<void>,
  ): Promise<void> {
    const staleReplicaCount = this.transactionState.staleReplicaCount;
    const revocationEpochs = [...this.transactionState.revocationEpochs];
    const authorizationSubjects = this.transactionState.authorizationSubjects.map((row) => ({
      ...row,
      subjects: [...row.subjects],
    }));
    const hasAuthorizationSubjectColumn = this.transactionState.hasAuthorizationSubjectColumn;
    const terminalAuthorizationSubjectHistory = [
      ...this.transactionState.terminalAuthorizationSubjectHistory,
    ];
    const stagePaths = [...this.transactionState.stagePaths];
    const recordedMigrations = [...this.transactionState.recordedMigrations];
    const events = [...this.transactionState.events];
    try {
      await callback(this.transactionState);
    } catch (error) {
      this.transactionState.staleReplicaCount = staleReplicaCount;
      this.transactionState.revocationEpochs.splice(0, Infinity, ...revocationEpochs);
      this.transactionState.authorizationSubjects = authorizationSubjects;
      this.transactionState.hasAuthorizationSubjectColumn = hasAuthorizationSubjectColumn;
      this.transactionState.terminalAuthorizationSubjectHistory =
        terminalAuthorizationSubjectHistory;
      this.transactionState.stagePaths = stagePaths;
      this.transactionState.recordedMigrations.splice(0, Infinity, ...recordedMigrations);
      this.transactionState.events.splice(0, Infinity, ...events);
      throw error;
    }
  }
}

function migration(tag: string, folderMillis: number): PgMigrationFile {
  return {
    tag,
    folderMillis,
    hash: tag,
    statements: [`${tag}-sql`],
  };
}

describe("PostgreSQL migration runner", () => {
  test("uses the generated 0043 migration as the transactional preflight boundary", async () => {
    const migrations = await loadPgMigrationFiles();
    const migration0043 = migrations.find((entry) => entry.tag === DATA_MARKET_0043_MIGRATION_TAG);

    expect(migration0043).toMatchObject({
      tag: DATA_MARKET_0043_MIGRATION_TAG,
      statements: expect.arrayContaining([
        expect.stringContaining("data_replicas_available_verification_check"),
      ]),
    });
  });

  test("upgrades a populated database from 0036 through 0042, 0043, and later migrations", async () => {
    const state = new MemoryMigrationTransaction(36, [
      { id: "reference", jobId: "job", inputDescriptor: "Reference data" },
      { id: "potcar", jobId: "job", inputDescriptor: "POTCAR/Si" },
    ]);
    const migrations = [
      migration("0036_daffy_valeria_richards", 36),
      migration("0042_shallow_silk_fever", 42),
      migration(DATA_MARKET_0043_MIGRATION_TAG, 43),
      migration("0044_clumsy_vulture", 44),
    ];

    await runPgMigrations(new MemoryMigrationRunner(state), migrations);

    expect(state.events).toEqual([
      "lock-migrations",
      "journal",
      "sql:0042_shallow_silk_fever-sql",
      "record:0042_shallow_silk_fever",
      "lock-0043",
      "preflight-bindings",
      "stale-replicas",
      "sql:0043_light_cloak-sql",
      "backfill-stage-paths",
      "record:0043_light_cloak",
      "sql:0044_clumsy_vulture-sql",
      "record:0044_clumsy_vulture",
    ]);
    expect(state.stagePaths).toEqual([
      { id: "reference", stagePath: "inputs/reference-data" },
      { id: "potcar", stagePath: "inputs/potcar-si" },
    ]);
    expect(state.staleReplicaCount).toBe(1);
  });

  test("runs cleanly on a fresh database without a populated backfill", async () => {
    const state = new MemoryMigrationTransaction(null, []);

    await runPgMigrations(new MemoryMigrationRunner(state), [
      migration("0000_baseline", 0),
      migration("0042_shallow_silk_fever", 42),
      migration(DATA_MARKET_0043_MIGRATION_TAG, 43),
    ]);

    expect(state.recordedMigrations).toEqual([
      "0000_baseline",
      "0042_shallow_silk_fever",
      DATA_MARKET_0043_MIGRATION_TAG,
    ]);
    expect(state.stagePaths).toEqual([]);
  });

  test("upgrades a populated 0045 database through 0046 without rejecting existing revocations", async () => {
    const state = new MemoryMigrationTransaction(45, [], {
      revocationEpochs: [null, 7, null],
    });

    await runPgMigrations(new MemoryMigrationRunner(state), [
      migration("0045_abnormal_nightcrawler", 45),
      {
        ...migration(DATA_DELIVERY_0046_MIGRATION_TAG, 46),
        statements: [
          'ALTER TABLE "data_delivery_revocations" ADD COLUMN "revoked_epoch" integer NOT NULL;',
          "ALTER TABLE jobs ADD COLUMN dispatch_epoch integer DEFAULT 0 NOT NULL;",
          "ALTER TABLE jobs ADD COLUMN revoked_epoch integer DEFAULT 0 NOT NULL;",
        ],
      },
    ]);

    expect(state.events).toEqual([
      "lock-migrations",
      "journal",
      "lock-0046",
      "add-revoked-epoch-nullable",
      "backfill-revoked-epoch",
      "finalize-revoked-epoch-not-null-default",
      "sql:ALTER TABLE jobs ADD COLUMN dispatch_epoch integer DEFAULT 0 NOT NULL;",
      "sql:ALTER TABLE jobs ADD COLUMN revoked_epoch integer DEFAULT 0 NOT NULL;",
      "record:0046_grey_maddog",
    ]);
    expect(state.revocationEpochs).toEqual([0, 7, 0]);
  });

  test("runs the 0046 nullable-to-not-null sequence on a fresh database", async () => {
    const state = new MemoryMigrationTransaction(null, []);

    await runPgMigrations(new MemoryMigrationRunner(state), [
      {
        ...migration(DATA_DELIVERY_0046_MIGRATION_TAG, 46),
        statements: [
          'ALTER TABLE "data_delivery_revocations" ADD COLUMN "revoked_epoch" integer NOT NULL;',
          "ALTER TABLE jobs ADD COLUMN dispatch_epoch integer DEFAULT 0 NOT NULL;",
          "ALTER TABLE jobs ADD COLUMN revoked_epoch integer DEFAULT 0 NOT NULL;",
        ],
      },
    ]);

    expect(state.recordedMigrations).toEqual([DATA_DELIVERY_0046_MIGRATION_TAG]);
    expect(state.revocationEpochs).toEqual([]);
  });

  test("adds the 0047 column before backfilling data-market subjects from frozen job facts", async () => {
    const state = new MemoryMigrationTransaction(46, [], {
      hasAuthorizationSubjectColumn: false,
      authorizationSubjects: [
        {
          bindingId: "binding",
          userId: "user-id",
          organizationId: "organization-id",
          source: "data-market",
          status: "pending",
          subjects: [],
        },
      ],
    });

    await runPgMigrations(new MemoryMigrationRunner(state), [
      {
        ...migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
        statements: [
          'ALTER TABLE "job_data_bindings" ADD COLUMN "authorization_subject_ids" jsonb DEFAULT \'[]\'::jsonb NOT NULL;',
        ],
      },
    ]);

    expect(state.hasAuthorizationSubjectColumn).toBe(true);
    expect(state.authorizationSubjects[0]?.subjects).toEqual([
      "user:user-id",
      "organization:organization-id",
    ]);
    expect(state.events).toEqual([
      "lock-migrations",
      "journal",
      "lock-0047",
      'sql:ALTER TABLE "job_data_bindings" ADD COLUMN "authorization_subject_ids" jsonb DEFAULT \'[]\'::jsonb NOT NULL;',
      "canonicalize-authorization-subjects",
      "record:0047_whole_pepper_potts",
    ]);
  });

  test("converts populated 0047 bare subjects using their frozen subject kind", async () => {
    const state = new MemoryMigrationTransaction(46, [], {
      authorizationSubjects: [
        {
          bindingId: "binding",
          userId: "user-id",
          organizationId: "organization-id",
          subjects: ["organization-id", "user-id", "organization-id", "user:already-typed"],
        },
      ],
    });

    await runPgMigrations(new MemoryMigrationRunner(state), [
      migration("0046_grey_maddog", 46),
      migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
    ]);

    expect(state.authorizationSubjects[0]?.subjects).toEqual([
      "organization:organization-id",
      "user:user-id",
      "user:already-typed",
    ]);
    expect(state.events).toEqual([
      "lock-migrations",
      "journal",
      "lock-0047",
      "sql:0047_whole_pepper_potts-sql",
      "canonicalize-authorization-subjects",
      "record:0047_whole_pepper_potts",
    ]);
  });

  test("fails closed and rolls back 0047 when a bare subject cannot be typed safely", async () => {
    const state = new MemoryMigrationTransaction(46, [], {
      authorizationSubjects: [
        {
          bindingId: "ambiguous",
          userId: "same-id",
          organizationId: "same-id",
          subjects: ["same-id"],
        },
      ],
    });

    await expect(
      runPgMigrations(new MemoryMigrationRunner(state), [
        migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
      ]),
    ).rejects.toBeInstanceOf(AuthorizationSubject0047PreflightError);

    expect(state.authorizationSubjects[0]?.subjects).toEqual(["same-id"]);
    expect(state.events).toEqual([]);
    expect(state.recordedMigrations).toEqual([]);
  });

  test("fails closed and rolls back 0047 when an active data-market binding lacks a subject", async () => {
    const state = new MemoryMigrationTransaction(46, [], {
      hasAuthorizationSubjectColumn: false,
      authorizationSubjects: [
        {
          bindingId: "active-without-subject",
          userId: null,
          organizationId: null,
          source: "data-market",
          status: "running",
          subjects: [],
        },
      ],
    });

    await expect(
      runPgMigrations(new MemoryMigrationRunner(state), [
        {
          ...migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
          statements: [
            'ALTER TABLE "job_data_bindings" ADD COLUMN "authorization_subject_ids" jsonb DEFAULT \'[]\'::jsonb NOT NULL;',
          ],
        },
      ]),
    ).rejects.toBeInstanceOf(AuthorizationSubject0047PreflightError);

    expect(state.hasAuthorizationSubjectColumn).toBe(false);
    expect(state.authorizationSubjects[0]?.subjects).toEqual([]);
    expect(state.events).toEqual([]);
  });

  test("retains terminal data-market history without a provable subject and records it", async () => {
    const state = new MemoryMigrationTransaction(46, [], {
      hasAuthorizationSubjectColumn: false,
      authorizationSubjects: [
        {
          bindingId: "terminal-without-subject",
          userId: null,
          organizationId: null,
          source: "data-market",
          status: "completed",
          subjects: [],
        },
      ],
    });

    await runPgMigrations(new MemoryMigrationRunner(state), [
      {
        ...migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
        statements: [
          'ALTER TABLE "job_data_bindings" ADD COLUMN "authorization_subject_ids" jsonb DEFAULT \'[]\'::jsonb NOT NULL;',
        ],
      },
    ]);

    expect(state.authorizationSubjects[0]?.subjects).toEqual([]);
    expect(state.terminalAuthorizationSubjectHistory).toEqual([
      { bindingId: "terminal-without-subject", status: "completed" },
    ]);
  });

  test("uses generated 0048 to convert bare subjects left by an already-applied 0047", async () => {
    const state = new MemoryMigrationTransaction(47, [], {
      authorizationSubjects: [
        {
          bindingId: "legacy",
          userId: "user-id",
          organizationId: "organization-id",
          subjects: ["user-id", "organization-id"],
        },
      ],
    });

    await runPgMigrations(new MemoryMigrationRunner(state), [
      migration(AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG, 47),
      {
        ...migration(AUTHORIZATION_SUBJECTS_0048_MIGRATION_TAG, 48),
        statements: [
          'ALTER TABLE "data_delivery_revocations" ALTER COLUMN "revoked_epoch" SET DEFAULT 0;',
        ],
      },
    ]);

    expect(state.authorizationSubjects[0]?.subjects).toEqual([
      "user:user-id",
      "organization:organization-id",
    ]);
    expect(state.recordedMigrations).toEqual([AUTHORIZATION_SUBJECTS_0048_MIGRATION_TAG]);
  });

  test("fails closed on canonical stage-path conflicts and rolls back the preflight", async () => {
    const state = new MemoryMigrationTransaction(42, [
      { id: "first", jobId: "job", inputDescriptor: "POTCAR Si" },
      { id: "second", jobId: "job", inputDescriptor: "potcar-si" },
    ]);

    await expect(
      runPgMigrations(new MemoryMigrationRunner(state), [
        migration(DATA_MARKET_0043_MIGRATION_TAG, 43),
      ]),
    ).rejects.toBeInstanceOf(DataMarket0043PreflightError);

    expect(state.events).toEqual([]);
    expect(state.staleReplicaCount).toBe(0);
    expect(state.recordedMigrations).toEqual([]);
    expect(state.stagePaths).toEqual([]);
  });
});
