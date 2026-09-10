import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ValidationFinding, ValidationResult } from "../types.js";
import { prepareScenarios, runScenario, type PreparedScenario } from "./runner.js";
import type { LabReport } from "./types.js";
export async function runLabGate(input: { workspace: string; files: string[]; output: string; prepared?: PreparedScenario[] }): Promise<Pick<ValidationResult, "labReports" | "findings" | "passed" | "infrastructureFailure">> {
  const reports: LabReport[] = []; const findings: ValidationFinding[] = [];
  let infrastructureFailure = false;
  const scenarios = input.prepared ?? await prepareScenarios(input.files);
  for (let index = 0; index < scenarios.length; index++) {
    const prepared = scenarios[index];
    const label = path.relative(input.workspace, prepared.file).replaceAll(path.sep, "/");
    let currentHash: string | undefined;
    try { currentHash = createHash("sha256").update(await readFile(prepared.file)).digest("hex"); } catch { /* missing contract is a failure */ }
    if (currentHash !== prepared.hash) {
      findings.push({ id: `lab:${label}:contract-modified`, category: "lab", message: `Scenario contract was modified or removed: ${label}. Restore the original scenario; repair application code only.` });
      continue;
    }
    const directory = path.join(input.output, String(index + 1));
    const report = await runScenario({ file: prepared.file, workspace: input.workspace, outputDirectory: directory, prepared });
    reports.push(report);
    if (!report.passed) {
      const findingCountBefore = findings.length;
      const stepIds = new Set(prepared.scenario.steps.map(s => s.id));
      for (const event of report.events.filter(e => e.status === "failed" && (stepIds.has(e.id) || ["run-error", "cleanup", "runtime-cleanup"].includes(e.id)))) {
        findings.push({ id: `lab:${label}:${event.id}`, category: report.infrastructureFailure ? "lab-infra" : "lab", message: `${report.name}: ${event.message}`, details: `${JSON.stringify(event.evidence ?? {})}\nEvidence report: ${path.join(directory, "index.html")}` });
      }
      if (findings.length === findingCountBefore) findings.push({ id: `lab:${label}:incomplete`, category: "lab", message: `${report.name}: not every scenario step passed` });
    }
    if (report.infrastructureFailure) { infrastructureFailure = true; break; }
  }
  return { passed: findings.length === 0 && !infrastructureFailure, findings, labReports: reports, infrastructureFailure };
}
