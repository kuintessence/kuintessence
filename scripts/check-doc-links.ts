#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const siteRoot = resolve(root, "packages/docs-site/src");
const repositoryUrl = "https://github.com/kuintessence/kuintessence";
const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file.endsWith(".md") && existsSync(resolve(root, file))),
);
const failures: string[] = [];
let checked = 0;

function checkTarget(file: string, target: string, line: number): void {
  const value = target.replace(/^<|>$/g, "");
  const external = /^[a-z][a-z0-9+.-]*:/i.test(value);
  let relativePath: string;
  let base: string;
  if (external) {
    if (!value.startsWith(`${repositoryUrl}/`)) return;
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/kuintessence\/kuintessence\/(?:blob|tree|edit)\/main\/(.+)$/,
    );
    if (!match?.[1]) return;
    relativePath = decodeURIComponent(match[1]);
    base = root;
  } else {
    relativePath = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? "");
    if (!relativePath) return;
    const inSite = resolve(root, file).startsWith(`${siteRoot}/`);
    base = relativePath.startsWith("/") ? (inSite ? siteRoot : root) : dirname(resolve(root, file));
    relativePath = relativePath.replace(/^\/+/, "");
  }
  const candidate = resolve(base, relativePath);
  checked++;
  if (![candidate, `${candidate}.md`, resolve(candidate, "index.md")].some(existsSync)) {
    failures.push(`${file}:${line}: ${value}`);
  }
}

for (const file of files) {
  let fence: string | undefined;
  for (const [index, line] of readFileSync(resolve(root, file), "utf8").split(/\r?\n/).entries()) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (marker?.[1]) {
      if (!fence) {
        fence = marker[1][0];
      } else if (marker[1][0] === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g)) {
      if (match[1]) checkTarget(file, match[1], index + 1);
    }
    const definition = line.match(/^\s*\[[^\]]+\]:\s*(<[^>]+>|[^\s]+)/);
    if (definition?.[1]) checkTarget(file, definition[1], index + 1);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} local documentation targets across ${files.size} files.`);
}
