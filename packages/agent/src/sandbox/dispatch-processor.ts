import type { SandboxExecution } from "@kuintessence/proto";
import type { SandboxJobSpec } from "../adapters/base";
import type { SandboxManifestVerifier } from "./manifest-verifier";
import { decodeSandboxExecution } from "./proto-manifest";
import type { SandboxInputSource, SandboxStager } from "./stager";

export interface PreparedSandboxDispatch {
  workingDir: string;
  sandbox: SandboxJobSpec;
  runtimeDigest: string;
}

export class SandboxDispatchProcessor {
  constructor(
    private readonly verifier: SandboxManifestVerifier,
    private readonly stager: SandboxStager,
  ) {}

  async prepare(
    jobId: string,
    execution: SandboxExecution | undefined,
    inputSources: SandboxInputSource[] = [],
  ): Promise<PreparedSandboxDispatch> {
    const manifest = decodeSandboxExecution(jobId, execution);
    const verified = await this.verifier.verify(jobId, manifest);
    const prepared = await this.stager.prepare(verified, inputSources);
    return { ...prepared, runtimeDigest: verified.unsigned.runtime.digest };
  }
}
