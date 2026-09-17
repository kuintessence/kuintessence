import { type PgDb, scriptExecutionStats } from "@kuintessence/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export function sandboxInputSizeBucket(inputBytes: number): string {
  if (inputBytes < 1_048_576) return "lt-1mib";
  if (inputBytes < 104_857_600) return "1-100mib";
  if (inputBytes < 1_073_741_824) return "100mib-1gib";
  return "gte-1gib";
}

export function correctedOutputEstimate(input: {
  manifestBytes: number;
  historicalBytes: number;
  sampleCount: number;
}): number {
  if (input.sampleCount <= 0 || input.historicalBytes < 0) return input.manifestBytes;
  const historicalWeight = Math.min(0.75, input.sampleCount / 20);
  return Math.max(
    0,
    Math.round(
      input.manifestBytes * (1 - historicalWeight) + input.historicalBytes * historicalWeight,
    ),
  );
}

export class SandboxExecutionStatsService {
  constructor(private readonly db: PgDb) {}

  async estimate(input: {
    assetRevisionId: string | null;
    inlineScriptHash: string | null;
    runtimeProfileId: string;
    inputBytes: number;
    manifestBytes: number;
  }): Promise<number> {
    const [row] = await this.db
      .select({
        sampleCount: scriptExecutionStats.sampleCount,
        averageOutputBytes: scriptExecutionStats.averageOutputBytes,
      })
      .from(scriptExecutionStats)
      .where(this.sourceCondition(input))
      .limit(1);
    return row
      ? correctedOutputEstimate({
          manifestBytes: input.manifestBytes,
          historicalBytes: row.averageOutputBytes,
          sampleCount: row.sampleCount,
        })
      : input.manifestBytes;
  }

  async record(input: {
    assetRevisionId: string | null;
    inlineScriptHash: string | null;
    runtimeProfileId: string;
    inputBytes: number;
    predictedOutputBytes: number;
    actualOutputBytes: number;
    succeeded: boolean;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const bucket = sandboxInputSizeBucket(input.inputBytes);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${input.assetRevisionId ?? input.inlineScriptHash}:${input.runtimeProfileId}:${bucket}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(scriptExecutionStats)
        .where(this.sourceCondition(input))
        .limit(1);
      const ratio = input.inputBytes > 0 ? input.actualOutputBytes / input.inputBytes : 0;
      const predictionError =
        input.actualOutputBytes === 0
          ? input.predictedOutputBytes === 0
            ? 0
            : 1
          : Math.abs(input.actualOutputBytes - input.predictedOutputBytes) /
            input.actualOutputBytes;
      if (!existing) {
        await tx.insert(scriptExecutionStats).values({
          assetRevisionId: input.assetRevisionId,
          inlineScriptHash: input.inlineScriptHash,
          runtimeProfileId: input.runtimeProfileId,
          inputSizeBucket: bucket,
          sampleCount: 1,
          successCount: input.succeeded ? 1 : 0,
          averageOutputBytes: input.actualOutputBytes,
          averageOutputRatio: ratio,
          averagePredictionError: predictionError,
        });
        return;
      }
      const sampleCount = existing.sampleCount + 1;
      const nextAverage = (current: number, observed: number) =>
        current + (observed - current) / sampleCount;
      await tx
        .update(scriptExecutionStats)
        .set({
          sampleCount,
          successCount: existing.successCount + (input.succeeded ? 1 : 0),
          averageOutputBytes: nextAverage(existing.averageOutputBytes, input.actualOutputBytes),
          averageOutputRatio: nextAverage(existing.averageOutputRatio, ratio),
          averagePredictionError: nextAverage(existing.averagePredictionError, predictionError),
          updatedAt: new Date(),
        })
        .where(eq(scriptExecutionStats.id, existing.id));
    });
  }

  private sourceCondition(input: {
    assetRevisionId: string | null;
    inlineScriptHash: string | null;
    runtimeProfileId: string;
    inputBytes: number;
  }) {
    return and(
      input.assetRevisionId
        ? eq(scriptExecutionStats.assetRevisionId, input.assetRevisionId)
        : isNull(scriptExecutionStats.assetRevisionId),
      input.inlineScriptHash
        ? eq(scriptExecutionStats.inlineScriptHash, input.inlineScriptHash)
        : isNull(scriptExecutionStats.inlineScriptHash),
      eq(scriptExecutionStats.runtimeProfileId, input.runtimeProfileId),
      eq(scriptExecutionStats.inputSizeBucket, sandboxInputSizeBucket(input.inputBytes)),
    );
  }
}
