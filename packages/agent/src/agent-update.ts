import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentUpdateReport, AgentUpdateReportSchema } from "@kuintessence/shared";

export async function readUpdateRequest(path: string): Promise<AgentUpdateReport | undefined> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error("Unsafe Agent update request file");
    return AgentUpdateReportSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}

async function save(path: string, value: AgentUpdateReport) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class AgentUpdateController {
  constructor(
    private readonly path: string,
    private readonly allowed: boolean,
    private readonly runningRelease: string | undefined,
  ) {}

  async receive(requestId: string, release: string) {
    const next = AgentUpdateReportSchema.parse({
      requestId,
      release,
      source: "remote",
      state: this.allowed ? "requested" : "disabled",
    });
    const current = await readUpdateRequest(this.path);
    if (current?.requestId === requestId) {
      if (current.release !== release) throw new Error("Update request ID changed its release");
      return;
    }
    if (current && !["succeeded", "failed", "disabled"].includes(current.state))
      throw new Error("Another Agent update is pending");
    await save(this.path, next);
  }

  async confirm(): Promise<boolean> {
    const current = await readUpdateRequest(this.path);
    if (current?.state === "restarting" && current.release === this.runningRelease) {
      current.state = "succeeded";
      await save(this.path, current);
      return true;
    }
    return false;
  }

  async report() {
    return readUpdateRequest(this.path);
  }
}

export function agentUpdatePath(dbPath: string) {
  return join(dirname(dbPath), "update-request.json");
}
