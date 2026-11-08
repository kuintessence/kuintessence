import type { SandboxExecution } from "@kuintessence/proto";
import type { SandboxJobSpec } from "../adapters/base";
import type { SandboxManifestVerifier } from "./manifest-verifier";
import { decodeSandboxExecution } from "./proto-manifest";
import type { SandboxInputSource, SandboxPreparationOptions, SandboxStager } from "./stager";

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

  async cleanup(jobId: string): Promise<void> {
    await this.stager.cleanup(jobId);
  }

  async prepare(
    jobId: string,
    execution: SandboxExecution | undefined,
    dispatchResources: { cpus: number; memoryMb: bigint },
    inputSources: SandboxInputSource[] = [],
    preparation: SandboxPreparationOptions = {},
  ): Promise<PreparedSandboxDispatch> {
    preparation.signal?.throwIfAborted();
    const manifest = decodeSandboxExecution(jobId, execution);
    const resources = manifest.resources;
    if (
      dispatchResources.cpus !== resources.cpus ||
      dispatchResources.memoryMb !== BigInt(resources.memoryMb)
    ) {
      throw new Error("Sandbox dispatch resources do not match the signed manifest");
    }
    const verified = await this.verifier.verify(jobId, manifest);
    if (preparation.restart) await this.stager.cleanup(jobId);
    try {
      const prepared = await this.stager.prepare(verified, inputSources, preparation);
      preparation.signal?.throwIfAborted();
      return { ...prepared, runtimeDigest: verified.unsigned.runtime.digest };
    } catch (error) {
      if (preparation.restart) await this.stager.cleanup(jobId);
      throw error;
    }
  }
}
