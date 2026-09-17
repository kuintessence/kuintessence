import type { SandboxDispatchIdentity } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import type { SandboxAccountVerifier } from "./manifest-verifier";

export class LocalSandboxAccountVerifier implements SandboxAccountVerifier {
  constructor(private readonly spawner: Spawner) {}

  async verify(identity: SandboxDispatchIdentity): Promise<boolean> {
    if (identity.backend === "Unix") {
      if (identity.uid <= 0 || identity.gid <= 0) return false;
      const result = await this.spawner.run(["getent", "passwd", identity.username]);
      if (result.exitCode !== 0) return false;
      const fields = result.stdout.trim().split(":");
      return Number(fields[2]) === identity.uid && Number(fields[3]) === identity.gid;
    }
    const result = await this.spawner.run([
      "kubectl",
      "get",
      "serviceaccount",
      identity.serviceAccount,
      "--namespace",
      identity.namespace,
      "--output",
      "name",
    ]);
    return (
      result.exitCode === 0 && result.stdout.trim() === `serviceaccount/${identity.serviceAccount}`
    );
  }
}
