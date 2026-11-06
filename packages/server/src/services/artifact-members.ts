import { createHash } from "node:crypto";
import { type SandboxArtifactMember, SandboxArtifactMemberSchema } from "@kuintessence/shared";

export function artifactBatchHash(members: readonly SandboxArtifactMember[]): string {
  const hash = createHash("sha256");
  for (const member of members.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath)))
    hash.update(`${member.relativePath}\0${member.sizeBytes}\0${member.sha256}\n`);
  return hash.digest("hex");
}

export function validateArtifactMembers(input: {
  ioType: string;
  contentHash: string;
  sizeBytes: number;
  fileMembers?: readonly SandboxArtifactMember[] | null;
}): SandboxArtifactMember[] | null {
  if (input.ioType !== "FileBatch") {
    if (input.fileMembers != null) throw new Error("Only FileBatch artifacts can contain members");
    return null;
  }
  if (!input.fileMembers || input.fileMembers.length > 256)
    throw new Error("FileBatch requires a verified manifest of at most 256 files");
  const members = input.fileMembers.map((member) => SandboxArtifactMemberSchema.parse(member));
  const paths = new Set(members.map((member) => member.relativePath));
  if (paths.size !== members.length) throw new Error("FileBatch contains duplicate paths");
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join("/")))
        throw new Error("FileBatch contains overlapping file and directory paths");
  }
  const size = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  if (
    !Number.isSafeInteger(size) ||
    size !== input.sizeBytes ||
    artifactBatchHash(members) !== input.contentHash
  )
    throw new Error("FileBatch manifest does not match its size/hash");
  return members.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}
