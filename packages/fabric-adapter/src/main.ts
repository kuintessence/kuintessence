import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCommercialAdapter } from "./commercial-runtime";
import { startEvidenceAdapter } from "./runtime";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.env.KQ_FABRIC_ADAPTER_CONFIG;
  Promise.resolve()
    .then(() => {
      if (!config) throw new Error("Missing configuration file");
      const kind = process.env.KQ_FABRIC_ADAPTER_KIND ?? "evidence";
      if (kind !== "evidence" && kind !== "commercial") throw new Error("Invalid adapter kind");
      return kind === "commercial" ? startCommercialAdapter(config) : startEvidenceAdapter(config);
    })
    .then((close) => {
      let closing = false;
      const stop = () => {
        if (closing) return;
        closing = true;
        close().catch(() => {
          process.stderr.write("Fabric adapter shutdown failed\n");
          process.exitCode = 1;
        });
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    })
    .catch(() => {
      process.stderr.write("Fabric adapter startup failed; check local configuration and files\n");
      process.exitCode = 1;
    });
}
