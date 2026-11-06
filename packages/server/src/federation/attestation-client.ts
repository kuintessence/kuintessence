import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute } from "node:path";
import {
  type EvidenceAdvanceResult,
  type EvidenceProposalInput,
  EvidenceProposalInputSchema,
  FabricEvidenceAdvanceResultSchema,
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import { z } from "zod";

export interface AttestationClient {
  prepare(input: EvidenceProposalInput): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<EvidenceAdvanceResult>;
}
export class AttestationFailure extends Error {
  constructor(
    readonly code: string,
    readonly needsReview = false,
  ) {
    super(code);
  }
}
const KnownFailure = z.strictObject({
  code: z.enum([
    "POLICY_DENIED",
    "UNTRUSTED_IDENTITY",
    "OPERATION_CONFLICT",
    "INVALID_MESSAGE",
    "INVALID_RECOVERY",
    "INVALID_LEDGER_RESPONSE",
    "LEDGER_UNAVAILABLE",
    "ADAPTER_BUSY",
  ]),
});

/** The Server never imports Fabric SDK or probes a ledger during direct-mode admission. */
export class UnixAttestationClient implements AttestationClient {
  constructor(private readonly socketPath: string) {
    if (!isAbsolute(socketPath)) throw new Error("Attestation socket must be an absolute path");
  }

  async prepare(input: EvidenceProposalInput) {
    return FabricProposalCheckpointSchema.parse(
      await this.call("/v1/evidence/proposal", EvidenceProposalInputSchema.parse(input)),
    );
  }

  async advance(recovery: string) {
    return FabricEvidenceAdvanceResultSchema.parse(
      await this.call("/v1/evidence/advance", {
        recovery: FabricRecoveryTokenSchema.parse(recovery),
      }),
    );
  }

  private async call(path: string, input: unknown): Promise<unknown> {
    try {
      const dir = await lstat(dirname(this.socketPath));
      const socket = await lstat(this.socketPath);
      if (
        !dir.isDirectory() ||
        !socket.isSocket() ||
        dir.mode & 0o077 ||
        socket.mode & 0o077 ||
        dir.uid !== process.getuid?.() ||
        socket.uid !== process.getuid?.()
      )
        throw new AttestationFailure("UNSAFE_ADAPTER_SOCKET", true);
    } catch (error) {
      if (error instanceof AttestationFailure) throw error;
      throw new AttestationFailure("LEDGER_UNAVAILABLE");
    }
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(input));
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": body.length },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4_194_560) {
              res.destroy();
              reject(new AttestationFailure("INVALID_ADAPTER_RESPONSE", true));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => reject(new AttestationFailure("LEDGER_UNAVAILABLE")));
          res.on("end", () => {
            try {
              if (res.headers["content-type"] !== "application/json")
                throw new Error("Invalid content type");
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode === 200) {
                resolve(value);
                return;
              }
              const failure = KnownFailure.safeParse(value);
              if (!failure.success) throw new Error("Invalid response");
              const code = failure.data.code;
              reject(
                new AttestationFailure(
                  code,
                  code !== "LEDGER_UNAVAILABLE" && code !== "ADAPTER_BUSY",
                ),
              );
            } catch {
              reject(new AttestationFailure("INVALID_ADAPTER_RESPONSE", true));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(), 25_000);
      req.once("close", () => clearTimeout(timer));
      req.on("error", () => reject(new AttestationFailure("LEDGER_UNAVAILABLE")));
      req.end(body);
    });
  }
}
