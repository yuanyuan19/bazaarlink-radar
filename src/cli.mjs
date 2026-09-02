#!/usr/bin/env node
import { COMMANDS, usage } from "./commands.mjs";
import { parseArgs } from "./util.mjs";

const { cmd, flags, pos } = parseArgs(process.argv.slice(2));

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  process.stdout.write(usage() + "\n");
  process.exit(0);
}

const fn = COMMANDS[cmd];
if (!fn) {
  process.stderr.write(`未知命令: ${cmd}\n\n${usage()}\n`);
  process.exit(1);
}

try {
  const code = await fn(flags, pos);
  process.exit(code ?? 0);
} catch (err) {
  const status = err.status;
  const body = err.body;
  process.stderr.write(
    JSON.stringify(
      {
        error: err.message,
        status: status || undefined,
        body: typeof body === "string" ? body.slice(0, 400) : body,
      },
      null,
      flags.pretty ? 2 : 0,
    ) + "\n",
  );
  process.exit(1);
}
