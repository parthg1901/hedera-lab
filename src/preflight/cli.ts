import path from "node:path";
import { readFile } from "node:fs/promises";
import { constructApproval } from "./repair.js";
import { runPreflight } from "./run.js";
export async function runPreflightCli(args: string[]) {
  if (args[0] === "construct") {
    if (args.length !== 3)
      throw new Error("Usage: preflight construct <policy.json> <intent.json>");
    const policy = JSON.parse(await readFile(args[1]!, "utf8"));
    const intent = JSON.parse(await readFile(args[2]!, "utf8"));
    console.log(JSON.stringify(constructApproval(policy, intent), null, 2));
    return;
  }
  const [workspaceArg = "examples/preflight", ...rest] = args;
  if (rest.length > 1)
    throw new Error(
      "Usage: preflight [registered-workspace] [output-directory]",
    );
  const workspace = path.resolve(workspaceArg),
    output = path.resolve(rest[0] ?? ".harness/runs/preflight-" + Date.now());
  const report = await runPreflight(
    path.join(workspace, "scenario.json"),
    workspace,
    output,
  );
  console.log(
    JSON.stringify(
      {
        decision: report.preflight.decision,
        block: report.preflight.snapshot.block,
        mode: report.mode,
        report: path.join(output, "report.json"),
      },
      null,
      2,
    ),
  );
  process.exitCode = report.infrastructureFailure ? 2 : report.passed ? 0 : 1;
}
