import path from "node:path";
import { executeCommand } from "../command.js";
import { loadScenario } from "./schema.js";
import { runScenario } from "./runner.js";
import { mirrorGet } from "./mirror.js";

export async function runLabCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "onboard") {
    const { runOnboardingCli } = await import("./onboard.js");
    await runOnboardingCli(rest);
    return;
  }
  if (command === "up") {
    if (rest.length) throw new Error("Usage: hedera-harness lab up");
    const docker = await executeCommand({ command: "docker", args: ["info", "--format", "{{.ServerVersion}}"], cwd: process.cwd(), timeoutMs: 10_000 }).catch(() => ({ exitCode: 127 }));
    if (docker.exitCode !== 0) throw new Error("Lab local network requires a running Docker daemon. See https://solo.hiero.org/docs/simple-solo-setup/quickstart/");
    const solo = await executeCommand({ command: "solo", args: ["--version"], cwd: process.cwd(), timeoutMs: 10_000 }).catch(() => ({ exitCode: 127 }));
    if (solo.exitCode !== 0) throw new Error("Install Solo first: npm install -g @hiero-ledger/solo (requires Node >=22)");
    const result = await executeCommand({ command: "solo", args: ["one-shot", "single", "deploy"], cwd: process.cwd(), timeoutMs: 1_800_000, streamOutput: true });
    if (result.exitCode !== 0) throw new Error("Solo deployment failed; inspect its output and existing resources before retrying");
    console.log("Solo deployed. Copy its reported gRPC and mirror ports into your local scenario; run lab doctor to verify. Teardown: solo one-shot single destroy.");
    return;
  }
  if (command !== "run" && command !== "doctor") throw new Error("Usage: hedera-harness lab <run|doctor> <scenario.yaml> [--workspace <path>] [--output <path>] or lab up");
  const file = rest.shift();
  if (!file || file.startsWith("-")) throw new Error("A scenario path is required");
  let workspace = process.cwd(); let output: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]; const value = rest[i + 1];
    if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--workspace") workspace = path.resolve(value);
    else if (flag === "--output" && command === "run") output = path.resolve(value);
    else throw new Error(`Unknown lab option ${flag}`);
  }
  const scenarioFile = path.resolve(file);
  if (command === "doctor") {
    const { scenario } = await loadScenario(scenarioFile);
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [{ name: "schema", ok: true, detail: `${scenario.steps.length} steps, ${scenario.network.mode}` }];
    if (scenario.network.mode !== "simulated") {
      for (const env of [scenario.network.operatorIdEnv ?? "HEDERA_OPERATOR_ID", scenario.network.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY"]) checks.push({ name: env, ok: Boolean(process.env[env]?.trim()), detail: process.env[env]?.trim() ? "set" : "missing" });
      try { const response = await mirrorGet(scenario.network.mode === "testnet" ? "https://testnet.mirrornode.hedera.com" : scenario.network.mirrorUrl!, "/api/v1/network/nodes?limit=1"); checks.push({ name: "mirror", ok: response.status === 200, detail: `HTTP ${response.status}` }); }
      catch (e) { checks.push({ name: "mirror", ok: false, detail: (e as Error).message }); }
    }
    if (scenario.server) {
      try {
        const { importPlaywright } = await import("../optionalDeps.js");
        const { resolveMcpBrowser, playwrightLaunchOptionsForBrowser } = await import("../mcpBrowser.js");
        const { chromium } = await importPlaywright({ projectRoot: workspace });
        const browser = await chromium.launch(playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(workspace))); await browser.close();
        checks.push({ name: "browser", ok: true, detail: "launch succeeded" });
      } catch { checks.push({ name: "browser", ok: false, detail: "Install playwright and Chromium with system dependencies" }); }
    }
    for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    return;
  }
  const report = await runScenario({ file: scenarioFile, workspace, outputDirectory: output });
  console.log(`${report.infrastructureFailure ? "ABORT" : report.passed ? "PASS" : "FAIL"} ${report.name} [${report.mode}]`);
  for (const event of report.events.filter(e => e.status === "failed")) console.log(`  ${event.id}: ${event.message}`);
  console.log(`Report: ${path.join(output ?? path.join(workspace, ".harness/runs/lab", report.runId), "index.html")}`);
  if (!report.passed) process.exitCode = 1;
}
