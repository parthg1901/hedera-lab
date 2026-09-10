import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MainnetMirror } from "./mirror.js";
import { verifyApproval } from "./verify.js";
import {
  validatePolicy,
  validateProposal,
  type Policy,
  type Proposal,
} from "./model.js";
export async function runPreflight(
  specFile: string,
  workspace: string,
  output: string,
) {
  const spec = JSON.parse(await readFile(specFile, "utf8"));
  const confined = (f: string) => {
    if (typeof f !== "string") throw new Error("Missing registered input path");
    const p = path.resolve(workspace, f),
      relative = path.relative(workspace, p);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Preflight inputs must be inside registered workspace");
    return p;
  };
  const policy = validatePolicy(
    JSON.parse(await readFile(confined(spec.policy), "utf8")) as Policy,
  );
  const proposal = validateProposal(
    JSON.parse(await readFile(confined(spec.proposal), "utf8")) as Proposal,
  );
  const mirror = new MainnetMirror();
  const snapshot = await mirror.snapshot();
  const simulation = await mirror.call(proposal, snapshot);
  const estimate = await mirror.call(proposal, snapshot, true);
  const evidence = verifyApproval(
    policy,
    proposal,
    snapshot,
    simulation,
    estimate,
  );
  const report = {
    schemaVersion: 1,
    name: "SAUCE approval preflight",
    mode: evidence.mode,
    passed: evidence.decision === "accept",
    infrastructureFailure: evidence.checks.some((c) => c.status === "unknown"),
    browserExecuted: false,
    events: evidence.checks.map((c) => ({
      ...c,
      kind: "assertion",
      status: c.status === "unknown" ? "failed" : c.status,
    })),
    preflight: evidence,
  };
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
