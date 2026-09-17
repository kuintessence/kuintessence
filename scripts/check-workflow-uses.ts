import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const workflowRoots = [".github/workflows"];
const allowed = [
  /^\.\//,
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[\w./-]+$/,
  /^docker:\/\/.+/,
];

function workflowFiles(root: string): string[] {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => join(root, entry));
}

const violations = workflowRoots.flatMap((root) =>
  workflowFiles(root).flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .flatMap((line, index) => {
        const match = line.match(/^\s*(?:-\s*)?uses:\s*(?:["']([^"']+)["']|([^\s#]+))/);
        if (!match) return [];
        const value = match[1] ?? match[2] ?? "";
        return allowed.some((pattern) => pattern.test(value))
          ? []
          : [`${file}:${index + 1}: ${value}`];
      }),
  ),
);

if (violations.length) {
  console.error("Non-portable workflow uses: references:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("workflow uses: references use GitHub Actions syntax");
