import { createInterface } from "node:readline";

// Never emit raw logs, error messages, request bodies, credentials or query strings.
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.length > 128 * 1024) continue;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    continue;
  }
  if (typeof value !== "object" || value === null) continue;
  const record = value as Record<string, unknown>;
  if (record.msg !== "Unhandled error" || typeof record.err !== "object" || record.err === null) {
    continue;
  }
  const error = record.err as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["type", "code", "syscall"]) {
    const field = error[key];
    if (typeof field === "string" && /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(field)) {
      safe[key] = field;
    }
  }
  if (typeof error.stack === "string") {
    safe.frames = error.stack.match(/\/workspace\/packages\/[A-Za-z0-9_./-]+:\d+:\d+/g)?.slice(0, 12);
  }
  console.log("Spack case: sanitized Registry error", JSON.stringify(safe));
}
