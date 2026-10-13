import type { SpackMaterialBinding, SpackMaterialManifest } from "@kuintessence/shared/browser";
import { useState } from "react";
import { softwareWriteHeaders } from "../../lib/software-client";
import { Button } from "../ui/button";

export function MaterialEvidence({
  manifest,
  binding,
  isCurrent,
}: {
  manifest: SpackMaterialManifest;
  binding: SpackMaterialBinding;
  isCurrent: () => boolean;
}) {
  const [error, setError] = useState("");
  if (manifest.version !== 2) return null;
  async function download(path: string, digest: string, size: number) {
    if (!isCurrent()) return;
    setError("");
    try {
      // Notice/evidence downloads are bounded; source archives stay on the streaming Registry API.
      if (size > 32 * 1024 ** 2)
        throw new Error(
          "附件超过浏览器下载上限 32 MiB，请使用已授权的 Registry blob API 流式下载。",
        );
      const response = await fetch(
        `/software/api/spack/material-repositories/${binding.repositoryId}/releases/${binding.manifestDigest}/blobs/${digest}`,
        { headers: softwareWriteHeaders(), redirect: "error" },
      );
      if (!response.ok || Number(response.headers.get("Content-Length")) !== size)
        throw new Error("附件下载失败");
      const bytes = await response.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      if (bytes.byteLength !== size || `sha256:${hash}` !== digest)
        throw new Error("附件摘要不匹配");
      if (!isCurrent()) return;
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split("/").at(-1) ?? "evidence";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : "附件下载失败");
    }
  }
  return (
    <section className="space-y-2 text-xs" aria-label="材料许可证与证据">
      <h4>材料许可证与证据（原始声明）</h4>
      {manifest.evidence.materials.map((entry) => (
        <div key={entry.subject.digest} className="break-all border p-2">
          <p>
            {entry.subject.digest} · {entry.subject.size} bytes
          </p>
          <p>
            {entry.license.expression} · {entry.license.status}
          </p>
          {entry.provenance.map((origin) => (
            <p key={`${origin.origin}:${origin.evidence.digest}:${origin.original.digest}`}>
              {origin.origin} · {origin.original.digest} → {entry.subject.digest}
            </p>
          ))}
          {entry.attachments.map((attachment) => (
            <Button
              key={attachment.path}
              variant="link"
              onClick={() =>
                void download(attachment.path, attachment.blob.digest, attachment.blob.size)
              }
            >
              {attachment.kind}: {attachment.path}
            </Button>
          ))}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
