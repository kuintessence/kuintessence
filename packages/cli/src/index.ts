#!/usr/bin/env bun
import { Command } from "commander";
import { registerAgentCommand } from "./commands/agent";
import { registerCancelCommand } from "./commands/cancel";
import { registerConfigCommand } from "./commands/config";
import { registerDslCommand } from "./commands/dsl";
import { registerGuiCommand } from "./commands/gui";
import { registerListCommand } from "./commands/list";
import { registerLoginCommand } from "./commands/login";
import { registerLogsCommand } from "./commands/logs";
import { registerMeteringCommand } from "./commands/metering";
import { registerSoftwareCommand } from "./commands/software";
import { registerSshCommand } from "./commands/ssh";
import { registerStatusCommand } from "./commands/status";
import { registerSubmitCommand } from "./commands/submit";
import { registerTuiCommand } from "./commands/tui";
import { registerWorkflowCommand } from "./commands/workflow";
import { formatCliError } from "./lib/cli-error";
import { KQ_VERSION } from "./version";

const program = new Command();
program.name("kq").description("Kuintessence CLI — submit and manage HPC jobs").version(KQ_VERSION);

registerLoginCommand(program);
registerSubmitCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerCancelCommand(program);
registerWorkflowCommand(program);
registerAgentCommand(program);
registerSshCommand(program);
registerLogsCommand(program);
registerSoftwareCommand(program);
registerMeteringCommand(program);
registerDslCommand(program);
registerTuiCommand(program);
registerGuiCommand(program);
registerConfigCommand(program);

program.parseAsync().catch((err: unknown) => {
  console.error(formatCliError(err));
  process.exit(1);
});
