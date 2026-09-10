import { loadScenario } from "../dist/lab/schema.js";

const usage = "Usage: node scripts/lab-recovery-eval.mjs [--testnet | --local <scenario.yaml>] [--crash]";

/** Validate before creating journals or provisioning any live resources. */
export async function recoveryConfig(args, { env = process.env, platform = process.platform } = {}) {
  let mode = "simulated";
  let scenarioFile;
  let crash = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--crash" && !crash) crash = true;
    else if (args[i] === "--testnet" && mode === "simulated") mode = "testnet";
    else if (args[i] === "--local" && mode === "simulated" && args[i + 1] && !args[i + 1].startsWith("--")) {
      mode = "local";
      scenarioFile = args[++i];
    } else throw Error(usage);
  }
  if (crash && mode === "simulated") throw Error("--crash requires --testnet or --local <scenario.yaml>");
  if (crash && platform !== "linux")
    throw Error("--crash requires Linux with util-linux flock; other platforms require manual exclusive-file recovery. Run in Linux; never remove owner.guard.");
  let config = { mode };
  if (scenarioFile) {
    const { scenario } = await loadScenario(scenarioFile);
    if (scenario.network.mode !== "local") throw Error("--local requires a scenario with network.mode: local; no network fallback is allowed");
    config = scenario.network;
  }
  const operatorVariables = [config.operatorIdEnv ?? "HEDERA_OPERATOR_ID", config.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY"];
  if (mode !== "simulated" && operatorVariables.some(key => !env[key]?.trim()))
    throw Error(`${mode} operator environment variables are required: ${operatorVariables.join(", ")}`);
  return { config, crash, live: mode !== "simulated", operatorVariables };
}
