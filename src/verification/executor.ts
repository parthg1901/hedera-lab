import { prepareApplicationOperations } from "../lab/plan.js";
import { operatorKeyMaterial } from "../lab/live.js";
import { executionTerms } from "./contracts.js";
import { loadScenario } from "../lab/schema.js";
import { mirrorGet } from "../lab/mirror.js";
import path from "node:path";
import { runPreflight } from "../preflight/run.js";
import { runProtocol } from "./protocol.js";
import { runScenario } from "../lab/runner.js";
import type { Job, Pack, Quote } from "./model.js";
import type { Executor } from "./engine.js";
/** Serialize shared registered workspaces. Each repetition gets fresh Lab fixtures. */
export class LabExecutor implements Executor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private packs: Pack[],
    private output: string,
  ) {}
  async readiness(pack: Pack, probe = false) {
    const terms = await executionTerms(pack);
    if (!pack.driver) {
      try { await prepareApplicationOperations((await loadScenario(pack.scenario)).scenario, pack.workspace); }
      catch { return { available: false, reason: "Registered application plan is missing or invalid" }; }
    }
    if (terms.access !== "ledger-write") {
      if (probe && terms.environment === "mainnet-preflight") {
        try {
          await mirrorGet(
            "https://mainnet-public.mirrornode.hedera.com",
            "/api/v1/blocks?limit=1&order=desc",
          );
        } catch {
          return { available: false, reason: "Mainnet mirror is unavailable" };
        }
      }
      return {
        available: true,
        reason:
          terms.access === "read-only"
            ? "Read-only mainnet preflight; no signing key or submission"
            : "In-process simulation executor",
      };
    }
    if (!pack.funding)
      return {
        available: false,
        reason: "Provider has not configured enforced live funding limits",
      };
    const { scenario } = await loadScenario(pack.scenario);
    const network = scenario.network;
    if (
      !process.env[network.operatorIdEnv ?? "HEDERA_OPERATOR_ID"] ||
      !(
        process.env[network.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY"] ||
        process.env[(network.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY") + "_FILE"]
      )
    )
      return {
        available: false,
        reason: "Live execution operator is not configured on this worker",
      };
    if (probe) {
      try {
        const { importHieroSdk } = await import("../optionalDeps.js");
        const sdk = await importHieroSdk();
        const key = sdk.PrivateKey.fromStringECDSA(
          (await operatorKeyMaterial(network)).replace(/^0x/i, ""),
        );
        const id = process.env[network.operatorIdEnv ?? "HEDERA_OPERATOR_ID"]!;
        const base =
          network.mode === "testnet"
            ? "https://testnet.mirrornode.hedera.com"
            : network.mirrorUrl!;
        const response = await mirrorGet(base, `/api/v1/accounts/${id}`);
        const account = response.body as any;
        if (
          response.status !== 200 ||
          account.deleted ||
          account.key?.key?.toLowerCase() !==
            key.publicKey.toStringRaw().toLowerCase() ||
          !Number.isSafeInteger(account.balance?.balance) ||
          BigInt(account.balance.balance) < BigInt(terms.maximumExposureTinybar)
        )
          return {
            available: false,
            reason:
              "Operator identity or available execution funds failed preflight",
          };
      } catch {
        return {
          available: false,
          reason: "Execution network or operator preflight failed",
        };
      }
    }
    return {
      available: true,
      reason:
        "Configured live adapter with per-submission fee limits; readiness checked before payment",
    };
  }
  run(q: Quote, j: Job, selected = q.selection) {
    const work = this.queue.then(async () => {
      const runs = [];
      let infrastructureFailure = false;
      for (const selection of selected) {
        const pack = this.packs.find((p) => p.id === selection.pack)!;
        for (
          let iteration = 1;
          iteration <= selection.repetitions;
          iteration++
        ) {
          const report =
            pack.driver === "mainnet-preflight"
              ? await runPreflight(
                  pack.scenario,
                  pack.workspace,
                  path.join(this.output, j.id, `${pack.id}-${iteration}`),
                )
              : pack.driver === "ticket-protocol" ||
                  pack.driver === "exchange-protocol"
                ? await runProtocol(
                    pack,
                    path.join(this.output, j.id, `${pack.id}-${iteration}`),
                  )
                : await runScenario({
                    funding: q.execution?.find((e) => e.pack === pack.id)
                      ?.terms,
                    file: pack.scenario,
                    workspace: pack.workspace,
                    outputDirectory: path.join(
                      this.output,
                      j.id,
                      `${pack.id}-${iteration}`,
                    ),
                  });
          runs.push({ pack: pack.id, iteration, report });
          if (report.infrastructureFailure) {
            infrastructureFailure = true;
            break;
          }
        }
        if (infrastructureFailure) break;
      }
      return {
        infrastructureFailure,
        report: {
          schemaVersion: 1,
          settlement: q.settlement,
          execution: q.execution,
          serviceFeeTinybar: q.price,
          funding: runs.map((r) => ({
            pack: r.pack,
            iteration: r.iteration,
            ...("funding" in r.report && r.report.funding
              ? r.report.funding
              : r.report.mode === "local" || r.report.mode === "testnet"
                ? {
                    status: "unmetered",
                    actualFeeTinybar: null,
                    note: "No funding evidence collected; spending is unknown",
                  }
                : {
                    status: "not-required",
                    actualFeeTinybar: "0",
                    fixtureFundingTinybar: "0",
                    recoveredTinybar: "0",
                  }),
          })),
          jobId: j.id,
          quoteId: q.id,
          contractHash: q.contractHash,
          quotedExecutions: q.selection.reduce((n, s) => n + s.repetitions, 0),
          executed: runs.length,
          passed: !infrastructureFailure && runs.every((r) => r.report.passed),
          runs,
        },
      };
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
