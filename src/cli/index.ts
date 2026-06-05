#!/usr/bin/env node

import { runCli } from "./app.js";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

process.exitCode = exitCode;
