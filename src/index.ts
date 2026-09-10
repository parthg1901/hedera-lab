#!/usr/bin/env node
import { parseCliArgs, printHelp, runCli } from "./cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args[0] === "preflight") {
    const { runPreflightCli } = await import("./preflight/cli.js");
    await runPreflightCli(args.slice(1));
    return;
  }

  if (args[0] === "verify") {
    const { runVerificationCli } = await import("./verification/cli.js");
    await runVerificationCli(args.slice(1));
    return;
  }

  if (args[0] === "lab") {
    const { runLabCli } = await import("./lab/cli.js");
    await runLabCli(args.slice(1));
    return;
  }

  const parsed = parseCliArgs(args);
  await runCli(parsed);
}

main()
  .then(() => {
    // Force exit so leftover agent/dev-server handles cannot hang the CLI after
    // results are printed (see stopDevServer process-group teardown).
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
