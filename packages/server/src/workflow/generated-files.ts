import { createHash, randomUUID } from "node:crypto";
import { WorkflowExecutionInterrupted, workflowDsl } from "@kuintessence/shared";
import type { AuthzService } from "../authz/service";
import { enqueueNetDriveCommitAuthorization } from "../routes/netdrive";
import type { NetDriveService } from "../services/netdrive";
import type { LeasedWorkflowJournal } from "./execution-journal";

function defaultFileName(contentType: string) {
  if (contentType === "application/json") return "result.json";
  if (contentType.startsWith("text/plain")) return "result.txt";
  return "result.bin";
}

export async function publishGeneratedFiles(
  drive: NetDriveService,
  lease: LeasedWorkflowJournal,
  authz: AuthzService | undefined,
  ownerId: string,
  orgId: string | null,
  path: string,
  items: unknown[],
  output?: workflowDsl.ReduceOutput,
) {
  if (items.length > 256)
    throw new Error("Generate BatchFiles supports up to 256 files per invocation");
  let size = 0;
  if (output) workflowDsl.ReduceOutputSchema.parse(output);
  const bodies = [];
  for (const item of items) {
    let bytes: Buffer;
    let contentType = "application/json";
    if (
      output &&
      typeof item === "object" &&
      item &&
      "fileMetadataId" in item &&
      typeof item.fileMetadataId === "string"
    ) {
      const file = await drive.readWorkflowFile(ownerId, item.fileMetadataId);
      bytes = Buffer.from(file.bytes);
      contentType = file.contentType ?? "application/octet-stream";
    } else if (output && typeof item === "string") {
      bytes = Buffer.from(item);
      contentType = "text/plain; charset=utf-8";
    } else {
      const json = JSON.stringify(item);
      if (json === undefined) throw new Error("Generated file is not JSON");
      bytes = Buffer.from(json);
    }
    size += bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error("Generated batch exceeds 8 MiB");
    bodies.push({ bytes, contentType, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const key = JSON.stringify([path, "generated-files"]);
  let intent = await lease.read(key);
  if (!intent) {
    intent = {
      kind: "generated-files",
      files: bodies.map((blob) => ({ id: randomUUID(), sha256: blob.sha256 })),
    };
    await lease.write(key, intent);
  }
  if (intent.kind !== "generated-files" || intent.files.length !== bodies.length)
    throw new WorkflowExecutionInterrupted("Generated batch intent changed", { retryable: false });
  const blobs: Awaited<ReturnType<NetDriveService["stageGeneratedFile"]>>[] = [];
  for (const [i, body] of bodies.entries()) {
    const file = intent.files[i];
    if (!file || file.sha256 !== body.sha256)
      throw new WorkflowExecutionInterrupted("Generated batch content changed", {
        retryable: false,
      });
    await lease.renew();
    let destination: { relativePath: string; contentType: string } | undefined;
    if (output) {
      const prefix = output.kind === "OrderedFolder" ? `${String(i + 1).padStart(4, "0")}-` : "";
      const name = output.fileName ?? defaultFileName(body.contentType);
      destination = {
        relativePath: `${intent.files[0]?.id}/${prefix}${name}`,
        contentType: body.contentType,
      };
    }
    blobs.push(
      await drive.stageGeneratedFile(
        ownerId,
        lease.runId,
        file.id,
        body.bytes,
        body.sha256,
        destination,
      ),
    );
  }
  return lease.transaction(async (tx) => {
    const published = [];
    for (const blob of blobs) {
      const commit = await drive.publishGeneratedFile(ownerId, blob, tx, (result, db) =>
        enqueueNetDriveCommitAuthorization(authz, result, ownerId, orgId, db),
      );
      published.push({
        fileMetadataId: commit.file.id,
        fileMetadataName: blob.path.slice(blob.path.lastIndexOf("/") + 1),
        hash: blob.sha256,
        size: blob.size,
      });
    }
    return published;
  });
}
