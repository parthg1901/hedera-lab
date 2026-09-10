import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(
    process.argv[2] ?? ".harness/runs/preflight-evaluation-1",
  ),
  out = path.resolve(process.argv[3] ?? ".harness/runs/preflight-summary");
await mkdir(out, { recursive: true });
const corpus = JSON.parse(await readFile(root + "/corpus.json", "utf8")),
  agents = JSON.parse(await readFile(root + "/agents/summary.json", "utf8"));
if (agents.results.length !== corpus.entries.length * 2)
  throw Error("Do not publish an incomplete paired evaluation");
const boolTrue = (c) =>
  c.simulation?.httpStatus === 200 &&
  c.simulation.body?.result === "0x" + "0".repeat(63) + "1";
const summary = {
  block: corpus.snapshot.block,
  constructedCases: corpus.entries.length,
  expectedAccept: corpus.entries.filter((c) => c.expected === "accept").length,
  expectedReject: corpus.entries.filter((c) => c.expected === "reject").length,
  rawHttpSuccesses: corpus.entries.filter(
    (c) => c.simulation?.httpStatus === 200,
  ).length,
  abiTruePolicyViolations: corpus.entries
    .filter((c) => boolTrue(c) && c.expected === "reject")
    .map((c) => c.id),
  deterministicVerifierCorrect: corpus.entries.filter(
    (c) => c.lab?.decision === c.expected,
  ).length,
  agentComparison: agents.byArm,
  failedRepairs: agents.results
    .filter((r) => r.expected === "reject" && !r.repairPassed)
    .map((r) => ({
      case: r.case,
      arm: r.arm,
      proposal: r.answer?.proposal,
      error:
        r.error ?? r.repairError ?? "Independent final-proposal checks failed",
    })),
  allProtocolCompliant: agents.results.every((r) => r.protocolCompliant),
};
await writeFile(out + "/summary.json", JSON.stringify(summary, null, 2));
await writeFile(out + "/agent-results.json", JSON.stringify(agents, null, 2));
await copyFile(root + "/protocol.json", out + "/protocol.json");
await copyFile(root + "/corpus.json", out + "/mainnet-corpus.json");
console.log(JSON.stringify(summary, null, 2));
