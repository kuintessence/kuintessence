import { Command } from "commander";
import { registerAgentCommand } from "./commands/agent";
import { formatCliError } from "./lib/cli-error";

const program = new Command();
program.name("kq-agent-admin");
registerAgentCommand(program);
program.parseAsync().catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exit(1);
});
