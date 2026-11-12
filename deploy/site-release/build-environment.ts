import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sha256 } from "./source-provenance";

export interface BuildTool {
  path: string;
  sha256: string;
}

/** Deliberately do not merge process.env: Node/Bun preload, proxy and auth settings are inputs. */
export function formalBuildVariables(
  root: string,
  certificates: { SSL_CERT_FILE?: string; NODE_EXTRA_CA_CERTS?: string } = {},
): Record<string, string> {
  return {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
    npm_config_cache: join(root, "cache", "npm"),
    npm_config_userconfig: join(root, "empty-npmrc"),
    npm_config_globalconfig: join(root, "empty-npmrc"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    ...certificates,
  };
}

async function inspectTool(path: string): Promise<BuildTool> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (
    !isAbsolute(canonical) ||
    !stat.isFile() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    stat.size > 512 * 1024 ** 2
  )
    throw new Error("Formal build requires protected regular toolchain and CA files");
  return { path: canonical, sha256: sha256(await readFile(canonical)) };
}

export async function createFormalBuildEnvironment(root: string) {
  const nodePath = Bun.which("node", { PATH: "/usr/bin:/bin:/usr/local/bin" });
  if (!nodePath) throw new Error("Formal protobuf generation requires a system Node.js >=20");
  const bun = await inspectTool(process.execPath);
  const node = await inspectTool(nodePath);
  await mkdir(root, { mode: 0o700 });
  for (const name of ["bin", "home", "config", "cache", "tmp"])
    await mkdir(join(root, name), { mode: 0o700 });
  await writeFile(join(root, "empty-npmrc"), "", { mode: 0o400, flag: "wx" });
  await symlink(bun.path, join(root, "bin", "bun"));
  await symlink(node.path, join(root, "bin", "node"));
  const certificates: { SSL_CERT_FILE?: string; NODE_EXTRA_CA_CERTS?: string } = {};
  const caFiles: Array<BuildTool & { variable: "SSL_CERT_FILE" | "NODE_EXTRA_CA_CERTS" }> = [];
  for (const variable of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const) {
    const path = process.env[variable];
    if (!path) continue;
    if (!isAbsolute(path)) throw new Error("Formal build CA overrides must be absolute file paths");
    const file = await inspectTool(path);
    certificates[variable] = file.path;
    caFiles.push({ ...file, variable });
  }
  const osRelease = await inspectTool("/etc/os-release");
  const tracked = [bun, node, osRelease, ...caFiles];
  return {
    env: formalBuildVariables(root, certificates),
    bun,
    node,
    provenance: {
      policy: "allowlist-private-home" as const,
      platform: process.platform,
      architecture: process.arch,
      bun,
      node,
      osReleaseSha256: osRelease.sha256,
      caFiles,
      systemDependencies: "recorded-tools-host-os-and-system-trust" as const,
    },
    async verify() {
      for (const file of tracked) {
        const current = await inspectTool(file.path);
        if (current.path !== file.path || current.sha256 !== file.sha256)
          throw new Error("Formal build toolchain or trust file changed during execution");
      }
    },
  };
}
