import { dirname, join } from "node:path";

export type DeployForm = "tui" | "gui";

export interface ResolveDataDirOpts {
  form: DeployForm;
  home: string;
  explicit?: string;
  env?: string;
  execPath?: string;
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function resolveDataDir(opts: ResolveDataDirOpts): string {
  if (opts.explicit) return expandTilde(opts.explicit, opts.home);
  if (opts.env) return expandTilde(opts.env, opts.home);
  if (opts.form === "gui" && opts.execPath) return join(dirname(opts.execPath), "kuintessence");
  return join(opts.home, ".kuintessence");
}
