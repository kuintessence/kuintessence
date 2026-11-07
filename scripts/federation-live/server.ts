import server from "../../packages/server/src/index";

// Development login is confined to the test runner; Agents use the separate mTLS listener.
export default { ...server, hostname: "127.0.0.1" };
