const fs = require("node:fs");

function sanitizeConfig(config) {
  const context = config.contexts?.find((item) => item.name === config["current-context"])?.context;
  const cluster = config.clusters?.find((item) => item.name === context?.cluster)?.cluster;
  const user = config.users?.find((item) => item.name === context?.user)?.user;
  if (!context || !cluster || !user) throw new Error("KUBE_CONFIG needs a valid current context");
  const endpoint = new URL(cluster.server);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname) ||
    endpoint.port !== "6443" ||
    cluster["insecure-skip-tls-verify"] ||
    cluster["proxy-url"] ||
    cluster["certificate-authority"] ||
    !cluster["certificate-authority-data"]
  ) {
    throw new Error("KUBE_CONFIG requires HTTPS port 6443 and an inline CA, without proxy or insecure TLS");
  }
  if (
    Object.keys(user).some(
      (key) => !["client-certificate-data", "client-key-data", "token"].includes(key),
    ) ||
    !(user.token || (user["client-certificate-data"] && user["client-key-data"]))
  ) {
    throw new Error("KUBE_CONFIG requires inline client credentials; plugins and file references are forbidden");
  }
  const serverName = cluster["tls-server-name"] || endpoint.hostname;
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(serverName)) throw new Error("Invalid API TLS server name");
  return {
    apiVersion: "v1",
    kind: "Config",
    "current-context": "preview",
    clusters: [{
      name: "preview",
      cluster: {
        server: "https://127.0.0.1:16443",
        "certificate-authority-data": cluster["certificate-authority-data"],
        "tls-server-name": serverName,
      },
    }],
    users: [{ name: "preview", user }],
    contexts: [{ name: "preview", context: { cluster: "preview", user: "preview", namespace: "preview" } }],
  };
}

if (require.main === module) {
  try {
    const config = sanitizeConfig(JSON.parse(fs.readFileSync(0, "utf8")));
    fs.writeFileSync(process.argv[2], JSON.stringify(config), { mode: 0o600 });
  } catch {
    console.error("Invalid KUBE_CONFIG: use inline credentials and a verified HTTPS API CA.");
    process.exitCode = 1;
  }
}

module.exports = { sanitizeConfig };
