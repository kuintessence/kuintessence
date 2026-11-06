// Re-export generated protobuf message types, schemas, and service definition.
// AgentService is a GenService descriptor compatible with @connectrpc/connect.
// Use: createClient(AgentService, transport) on the Agent side,
//      createRoutes(AgentService, handlers) on the Server side.

export { sameDataDeliveryIntent, sameDispatchIntent } from "./dispatch-intent.js";
export * from "./generated/kuintessence/v1/agent_service_pb.js";
