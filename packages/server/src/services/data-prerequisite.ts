import { AppError, ErrorCode } from "@kuintessence/shared";

export interface DataRequirement {
  assetId: string;
  versionId: string;
  manifestDigest: string;
  requiredPaths?: string[];
}

export interface DataCandidateLocation {
  locationId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  kind: "object" | "cp-local";
  managedRootId?: string;
  relativePath?: string;
}

export interface ResolvedDataRequirement {
  requirement: DataRequirement;
  versionId: string;
  locations: DataCandidateLocation[];
}

export interface DataPrerequisiteRepository {
  resolveVersion(input: DataRequirement): Promise<{
    id: string;
    manifestDigest: string | null;
    available: boolean;
  } | null>;
  listLocations(versionId: string): Promise<DataCandidateLocation[]>;
  verifyAccess(input: {
    actorUserId: string;
    orgId: string | null;
    assetId: string;
    versionId: string;
  }): Promise<boolean>;
}

export interface DataPrerequisitePlan {
  requirements: ResolvedDataRequirement[];
  globalCandidateAgentIds: string[];
  localCandidateAgentIds: string[];
  eligibleAgentIds: string[];
}

export class DataPrerequisitePlanner {
  constructor(private readonly repository: DataPrerequisiteRepository) {}

  async build(input: {
    actorUserId: string;
    orgId: string | null;
    requirements: DataRequirement[];
    candidateAgentIds: string[];
  }): Promise<DataPrerequisitePlan> {
    const resolved: ResolvedDataRequirement[] = [];
    for (const requirement of input.requirements) {
      const allowed = await this.repository.verifyAccess({
        actorUserId: input.actorUserId,
        orgId: input.orgId,
        assetId: requirement.assetId,
        versionId: requirement.versionId,
      });
      if (!allowed) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Data access is not granted for ${requirement.assetId}`,
          403,
        );
      }
      const version = await this.repository.resolveVersion(requirement);
      if (!version?.available || version.id !== requirement.versionId) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          `Data version ${requirement.assetId}@${requirement.versionId} is unavailable`,
          404,
        );
      }
      if (version.manifestDigest !== requirement.manifestDigest) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_MANIFEST_MISMATCH", 409);
      }
      const locations = await this.repository.listLocations(version.id);
      resolved.push({ requirement, versionId: version.id, locations });
    }

    const globalCandidateAgentIds = unique(input.candidateAgentIds);
    const localSets = resolved
      .map((item) => item.locations.filter((location) => location.kind === "cp-local"))
      .filter((locations) => locations.length > 0)
      .map((locations) => new Set(locations.map((location) => location.agentId)));
    const localCandidateAgentIds =
      localSets.length === 0 ? [] : intersect(globalCandidateAgentIds, localSets);
    if (localSets.length > 0 && localCandidateAgentIds.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "DATA_LOCATION_CONFLICT: CP-local data replicas have no common candidate Agent",
        409,
      );
    }
    return {
      requirements: resolved,
      globalCandidateAgentIds,
      localCandidateAgentIds,
      eligibleAgentIds: localSets.length === 0 ? globalCandidateAgentIds : localCandidateAgentIds,
    };
  }

  async assertDispatchable(input: {
    actorUserId: string;
    orgId: string | null;
    requirements: DataRequirement[];
    agentId: string;
  }): Promise<DataPrerequisitePlan> {
    const plan = await this.build({ ...input, candidateAgentIds: [input.agentId] });
    if (!plan.eligibleAgentIds.includes(input.agentId)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `DATA_LOCATION_CONFLICT: Agent ${input.agentId} cannot access every CP-local data replica`,
        409,
      );
    }
    return plan;
  }
}

export class DataPrerequisitePlacementGate {
  constructor(private readonly planner: DataPrerequisitePlanner) {}

  prepare(input: Parameters<DataPrerequisitePlanner["build"]>[0]): Promise<DataPrerequisitePlan> {
    return this.planner.build(input);
  }

  verifyBeforeDispatch(input: Parameters<DataPrerequisitePlanner["assertDispatchable"]>[0]) {
    return this.planner.assertDispatchable(input);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intersect(candidates: string[], sets: Set<string>[]): string[] {
  if (sets.length === 0) return candidates;
  return candidates.filter((candidate) => sets.every((set) => set.has(candidate)));
}
