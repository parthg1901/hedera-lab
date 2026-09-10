import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pack } from "./model.js";
export async function runProtocol(pack: Pack, output: string) {
  const spec = JSON.parse(await readFile(pack.scenario, "utf8"));
  if (
    !(
      pack.driver === "exchange-protocol"
        ? [
            "payment-replay",
            "budget-race",
            "payment-timeout",
            "service-delivery",
          ]
        : [
            "purchase-replay",
            "checkin-replay",
            "concurrent-purchase",
            "timeout-recovery",
            "fault-combinations",
          ]
    ).includes(spec.suite)
  )
    throw new Error("Unknown protocol suite");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
  };
  const started = Date.now();
  let report: any;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              pack.driver === "exchange-protocol"
                ? "./exchange-worker.js"
                : "./protocol-worker.js",
              import.meta.url,
            ),
          ),
          spec.suite,
          pack.workspace,
        ],
        { env, cwd: pack.workspace, timeout: 30000, maxBuffer: 1_000_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end();
    });
    report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    if (!Array.isArray(report.events) || typeof report.passed !== "boolean")
      throw new Error("Invalid worker report");
  } catch {
    report = {
      schemaVersion: 1,
      mode: "simulated",
      browserExecuted: false,
      infrastructureFailure: false,
      passed: false,
      events: [
        {
          id: "application-execution",
          kind: "assertion",
          status: "failed",
          message:
            "Application failed to load, complete, or return a valid test result",
        },
      ],
    };
  }
  report.name = pack.title;
  report.durationMs = Date.now() - started;
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
