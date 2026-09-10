import path from "node:path";
import { prepareApplicationOperations } from "./plan.js";
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "playwright";
import { importPlaywright } from "../optionalDeps.js";
import { resolveMcpBrowser, playwrightLaunchOptionsForBrowser } from "../mcpBrowser.js";
import { createDevServerSession, type DevServerSession } from "../validation/devServer.js";
import { loadScenario } from "./schema.js";
import { SimulatedLedger } from "./simulated.js";
import { LiveLedger } from "./live.js";
import { startBridge } from "./bridge.js";
import { writeLabReport } from "./report.js";
import { LabInfrastructureError, type LabEvent, type LabReport, type LabScenario, type Ledger } from "./types.js";

export interface PreparedScenario { scenario: LabScenario; hash: string; file: string }
export async function prepareScenarios(files: string[]): Promise<PreparedScenario[]> {
  return Promise.all(files.map(async file => ({ ...await loadScenario(file), file })));
}
export async function runScenario(input: { file: string; workspace: string; outputDirectory?: string; prepared?: PreparedScenario; funding?: import("../verification/contracts.js").ExecutionTerms }): Promise<LabReport> {
  const prepared = input.prepared ?? { ...await loadScenario(input.file), file: input.file };
  let scenario = structuredClone(prepared.scenario);
  const start = Date.now();
  const report: LabReport = { schemaVersion: 1, runId: randomUUID(), name: scenario.name, scenarioPath: path.relative(input.workspace, input.file), scenarioHash: prepared.hash, mode: scenario.network.mode, passed: false, infrastructureFailure: false, startedAt: new Date(start).toISOString(), durationMs: 0, events: [], resources: { accounts: {}, tokens: {}, topics: {} }, browserExecuted: false };
  const outputDirectory = input.outputDirectory ?? path.join(input.workspace, ".harness/runs/lab", report.runId);
  const ledger: Ledger = scenario.network.mode === "simulated" ? new SimulatedLedger(scenario.faults) : new LiveLedger(scenario.network, outputDirectory, input.funding);
  let browser: Browser | undefined;
  let page: Page | undefined;
  let server: DevServerSession | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let bridgeInfra: LabInfrastructureError | undefined;
  let activeStep = "fixture";
  const emit = (event: Omit<LabEvent, "at">) => report.events.push({ ...event, at: new Date().toISOString() });
  try {
    const application = await prepareApplicationOperations(scenario, input.workspace);
    scenario = application.scenario;
    if (Object.keys(application.artifacts).length) report.applicationArtifacts = application.artifacts;
    try { await ledger.provision(scenario.fixtures); }
    catch (e) { throw new LabInfrastructureError(e instanceof Error ? e.message : "Fixture setup failed"); }
    report.resources = structuredClone(ledger.resources);
    emit({ id: "fixtures", kind: "fixture", status: "passed", message: "Fresh scenario resources provisioned", evidence: report.resources, durationMs: Date.now() - start });
    if (scenario.server) {
      try { bridge = await startBridge(ledger, scenario.fixtures, tx => emit({ id: `${activeStep}:${tx.transactionId}`, kind: "transaction", status: tx.status === "SUCCESS" ? "passed" : "failed", message: `${tx.operation.type}: ${tx.status}`, evidence: tx, durationMs: 0 }), e => { bridgeInfra = e; }, path.join(outputDirectory, "transactions")); }
      catch { throw new LabInfrastructureError("Lab bridge cannot listen on loopback; check host networking permissions"); }
      try {
        const { chromium } = await importPlaywright({ projectRoot: input.workspace });
        browser = await chromium.launch(playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(input.workspace)));
        page = await browser.newPage();
        page.setDefaultTimeout(scenario.timeoutMs);
      } catch { throw new LabInfrastructureError("Lab browser unavailable; install playwright and run npx playwright install chromium"); }
      // A server that cannot start is an app defect and is eligible for repair.
      server = await createDevServerSession(input.workspace, { command: scenario.server.command, configuredUrl: scenario.server.url, timeoutMs: scenario.server.timeoutMs, env: { HARNESS_LAB_URL: bridge.url, HARNESS_LAB_TOKEN: bridge.token, HARNESS_LAB_MODE: ledger.mode } }, "lab");
    }
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]; activeStep = step.id;
      const began = Date.now();
      try {
        if (bridgeInfra) throw bridgeInfra;
        if (step.operation) {
          const tx = await ledger.execute(step.operation);
          const expected = step.expectStatus ?? "SUCCESS";
          emit({ id: step.id, kind: "transaction", status: tx.status === expected ? "passed" : "failed", message: `${step.operation.type}: ${tx.status} (expected ${expected})`, evidence: tx, durationMs: Date.now() - began });
        } else if (step.browser) {
          report.browserExecuted = true;
          const action = step.browser;
          if (action.type === "goto") {
            const target = new URL(action.path!, server!.url);
            if (target.origin !== new URL(server!.url).origin) throw new Error("Browser route escapes app origin");
            const response = await page!.goto(target.href);
            if (!response || !response.ok()) throw new Error(`App navigation HTTP ${response?.status() ?? "unknown"}`);
          } else if (action.type === "click") await page!.locator(action.selector!).click();
          else await page!.locator(action.selector!).fill(action.value!);
          emit({ id: step.id, kind: "browser", status: "passed", message: `${action.type}: ${action.path ?? action.selector}`, evidence: action, durationMs: Date.now() - began });
        } else if (step.assert) {
          let matches = false; let evidence: unknown; let polls = 0;
          const deadline = began + scenario.timeoutMs;
          do {
            if (bridgeInfra) throw bridgeInfra;
            polls++;
            if (step.assert.type === "text") {
              const locator = page!.locator(step.assert.selector);
              const text = await locator.count() === 1 ? (await locator.textContent({ timeout: Math.min(1000, scenario.timeoutMs) }))?.trim() : null;
              matches = text === step.assert.equals; evidence = { actual: text, expected: step.assert.equals };
            } else ({ matches, evidence } = await ledger.observe(step.assert));
            if (matches || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(scenario.pollIntervalMs, Math.max(1, deadline - Date.now()))));
          } while (Date.now() <= deadline);
          emit({ id: step.id, kind: "assertion", status: matches ? "passed" : "failed", message: `${step.assert.type}: ${matches ? "verified" : "expected state not observed"}`, evidence: { expected: step.assert, observed: evidence, polls }, durationMs: Date.now() - began });
        }
      } catch (error) {
        if (error instanceof LabInfrastructureError) throw error;
        emit({ id: step.id, kind: step.assert ? "assertion" : step.browser ? "browser" : "transaction", status: "failed", message: error instanceof Error ? error.message : "Step failed", durationMs: Date.now() - began });
      }
      if (report.events.find(e => e.id === step.id)?.status === "failed") {
        for (const remaining of scenario.steps.slice(i + 1)) emit({ id: remaining.id, kind: remaining.assert ? "assertion" : remaining.browser ? "browser" : "transaction", status: "skipped", message: "Skipped after failed prerequisite", durationMs: 0 });
        break;
      }
    }
    if (bridgeInfra) throw bridgeInfra;
  } catch (error) {
    report.infrastructureFailure = error instanceof LabInfrastructureError;
    emit({ id: "run-error", kind: report.infrastructureFailure ? "infrastructure" : scenario.server ? "browser" : "transaction", status: "failed", message: error instanceof Error ? error.message : "Lab run failed", durationMs: Date.now() - start });
  } finally {
    report.resources = structuredClone(ledger.resources);
    const stopped = await Promise.allSettled([browser?.close(), server?.stop()]);
    try { await bridge?.stop(); } catch (reason) { stopped.push({ status: "rejected", reason }); }
    if (stopped.some(r => r.status === "rejected")) { report.infrastructureFailure = true; emit({ id: "runtime-cleanup", kind: "infrastructure", status: "failed", message: "Runtime teardown failed", durationMs: 0 }); }
    try {
      const errors = await ledger.cleanup();
      emit({ id: "cleanup", kind: "cleanup", status: errors.length ? "failed" : "passed", message: errors.length ? "Some resources could not be cleaned up" : "Scenario resources cleaned up", evidence: errors, durationMs: 0 });
      if (errors.length) report.infrastructureFailure = true;
    } catch { report.infrastructureFailure = true; emit({ id: "cleanup", kind: "cleanup", status: "failed", message: "Cleanup failed; inspect provisioned resource IDs", durationMs: 0 }); }
    report.resources = structuredClone(ledger.resources);
    if (ledger instanceof LiveLedger && input.funding) report.funding = await ledger.accounting();
    ledger.close();
  }
  // Only explicitly expected operation errors can pass; browser transaction failures
  // remain evidence, with scenario assertions deciding whether recovery was correct.
  report.passed = !report.infrastructureFailure && scenario.steps.every(s => { const events = report.events.filter(e => e.id === s.id); return events.length === 1 && events[0].status === "passed"; });
  report.durationMs = Date.now() - start;
  // Redact known credentials even if an application accidentally echoes them in DOM/errors.
  const secrets = [bridge?.token, process.env[scenario.network.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY"]].filter((s): s is string => Boolean(s));
  if (secrets.length) {
    let serialized = JSON.stringify(report);
    for (const secret of secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
    Object.assign(report, JSON.parse(serialized));
  }
  await writeLabReport(outputDirectory, report);
  return report;
}
