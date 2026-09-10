/** Publish only completed paired runs. Keep raw model traces and credentials local. */
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { runTicketStress } from "../dist/verification/ticketStress.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const digest = (s) => createHash("sha256").update(s).digest("hex");
const root = path.resolve(
  process.argv[2] ?? ".harness/runs/harness-comparison-v3",
);
const out = path.resolve(
  process.argv[3] ?? ".harness/runs/harness-comparison-summary",
);
const summary = JSON.parse(await readFile(root + "/summary.json", "utf8"));
if (!summary.complete || summary.results.length !== 6)
  throw Error("Refusing to publish an incomplete paired run");
await mkdir(out, { recursive: true });
await copyFile(root + "/protocol.json", out + "/protocol.json");
const stressResults = [];
const protocol = JSON.parse(await readFile(root + "/protocol.json", "utf8"));
for (const result of summary.results) {
  const dir = root + "/" + result.task + "-" + result.arm;
  const { stdout: seed } = await exec(
    "git",
    ["show", "main:ticket-service.mjs"],
    { cwd: dir + "/workspace" },
  );
  const expectedSeed = protocol.tasks.find(
    (t) => t.id === result.task,
  ).seedHash;
  result.seedAudit = {
    expectedHash: expectedSeed,
    actualHash: digest(seed),
    matches: digest(seed) === expectedSeed,
  };
  stressResults.push({
    task: result.task,
    arm: result.arm,
    ...(await runTicketStress(dir + "/workspace")),
  });
  const runs = await readdir(dir + "/workspace/.harness/runs", {
    withFileTypes: true,
  });
  let inputTokens = 0,
    outputTokens = 0,
    generatorCalls = 0,
    validatorCalls = 0,
    successfulMcpCalls = 0,
    successfulNavigations = 0,
    failedMcpCalls = 0;
  const attempts = [];
  for (const d of runs.filter((d) => d.isDirectory())) {
    const logs = dir + "/workspace/.harness/runs/" + d.name + "/logs";
    let files = [];
    try {
      files = await readdir(logs);
    } catch {}
    for (const f of files.filter((f) =>
      /^generator-attempt-\d+\.log$/.test(f),
    )) {
      generatorCalls++;
      const text = await readFile(logs + "/" + f, "utf8");
      const events = text.split("\n").flatMap((s) => {
        try {
          return [JSON.parse(s)];
        } catch {
          return [];
        }
      });
      for (const e of events.filter((e) => e.type === "turn.completed")) {
        inputTokens += e.usage?.input_tokens ?? 0;
        outputTokens += e.usage?.output_tokens ?? 0;
      }
      attempts.push({
        log: f,
        timedOut: text.includes("timedOut=true"),
        modelUsage: events
          .filter((e) => e.type === "turn.completed")
          .map((e) => e.usage),
      });
    }
    for (const f of files.filter((f) =>
      /^validator-attempt-\d+\.log$/.test(f),
    )) {
      validatorCalls++;
      const text = await readFile(logs + "/" + f, "utf8");
      const pointer = text
        .split("\n")
        .flatMap((s) => {
          try {
            return [JSON.parse(s)];
          } catch {
            return [];
          }
        })
        .find((e) => e.validatorEvidence);
      if (pointer) {
        const raw = JSON.parse(
          await readFile(pointer.validatorEvidence + "/raw.json", "utf8"),
        );
        for (const s of raw.stdout.split("\n")) {
          try {
            const e = JSON.parse(s);
            if (e.type === "turn.completed") {
              inputTokens += e.usage?.input_tokens ?? 0;
              outputTokens += e.usage?.output_tokens ?? 0;
            }
            if (
              e.type === "item.completed" &&
              e.item?.type === "mcp_tool_call" &&
              e.item.status === "completed" &&
              !e.item.error &&
              !e.item.result?.isError
            ) {
              successfulMcpCalls++;
              if (e.item.tool === "browser_navigate" && !e.item.result?.isError)
                successfulNavigations++;
            }
            if (
              e.type === "item.completed" &&
              e.item?.type === "mcp_tool_call" &&
              (e.item.status !== "completed" ||
                e.item.error ||
                e.item.result?.isError)
            )
              failedMcpCalls++;
          } catch {}
        }
      }
    }
  }
  result.modelExecution = {
    generatorCalls,
    validatorCalls,
    successfulMcpCalls,
    successfulNavigations,
    failedMcpCalls,
    inputTokens,
    outputTokens,
    attempts,
  };
  let report = {};
  try {
    report = JSON.parse(await readFile(dir + "/session.json", "utf8")).report;
  } catch {}
  await writeFile(
    out + "/" + result.task + "-" + result.arm + "-semantic.json",
    JSON.stringify(report.semanticValidation ?? { unavailable: true }, null, 2),
  );
  await copyFile(
    dir + "/repair.diff",
    out + "/" + result.task + "-" + result.arm + ".diff",
  );
}
await writeFile(
  out + "/stress-results.json",
  JSON.stringify(
    {
      scope: "Exploratory holdout, separate from frozen primary results",
      results: stressResults,
    },
    null,
    2,
  ),
);
await writeFile(out + "/summary.json", JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    summary.results.map((r) => ({
      task: r.task,
      arm: r.arm,
      harness: r.harnessPassed,
      independent: r.independentPassed,
      grade: r.grade.map((g) => ({ name: g.name, passed: g.passed })),
      ...r.modelExecution,
    })),
    null,
    2,
  ),
);
