export interface StaleAgentHeartbeatStore {
  sweepStaleHeartbeats(timeoutSec: number): Promise<string[]>;
}

export interface AgentHeartbeatSweepLogger {
  warn(context: { agentIds: string[]; timeoutSec: number }, message: string): void;
}

export async function reconcileStaleAgentHeartbeats(
  agentManager: StaleAgentHeartbeatStore,
  timeoutSec: number,
  logger: AgentHeartbeatSweepLogger,
): Promise<void> {
  const offlineAgentIds = await agentManager.sweepStaleHeartbeats(timeoutSec);
  if (offlineAgentIds.length > 0) {
    logger.warn(
      { agentIds: offlineAgentIds, timeoutSec },
      "Marked Agents offline after heartbeat timeout",
    );
  }
}
