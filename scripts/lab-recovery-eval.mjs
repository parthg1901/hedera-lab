#!/usr/bin/env node
/** Real bridge/application restart. Explicit --testnet or --local uses real HTS/HCS. */
import { execFileSync, fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SimulatedLedger } from "../dist/lab/simulated.js";
import { LiveLedger } from "../dist/lab/live.js";
import { startBridge } from "../dist/lab/bridge.js";
import { mirrorGet } from "../dist/lab/mirror.js";
import { createTicketService } from "../examples/lab-ticketing/ticket-service.mjs";
import { recoveryConfig } from "./lab-recovery-config.mjs";
import { probeUnsubmittedReceipt } from "./lab-recovery-probe.mjs";
const { config, live, crash, operatorVariables } = await recoveryConfig(process.argv.slice(2));
if (crash) {
  try {
    execFileSync("flock", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH }, timeout: 5000 });
  } catch {
    throw Error("--crash requires util-linux flock on PATH before provisioning fixtures");
  }
}
const output = path.resolve(".harness/runs/receipt-recovery-" + randomUUID());
await mkdir(output, { recursive: true });
const fixtures = {
  accounts: { organizer: { hbar: 3 }, customer: { hbar: 1 } },
  tokens: { ticket: { treasury: "organizer", supply: 1 } },
  topics: ["attendance"],
};
let ledger = live
  ? new LiveLedger(config, path.join(output, "ledger"))
  : new SimulatedLedger({ mirrorDelayMs: 0, rejectActors: [] });
let bridge;
let closedForRestart = false;
const events = [];
const infra = [];
const report = {
  mode: config.mode,
  network: config,
  passed: false,
  output,
  steps: [],
  hardCrash: crash,
  scope:
    "Bridge and application restart against the same ledger; no payment performed",
  cleanupErrors: [],
};
const must = (condition, message) => {
  if (!condition) throw Error(message);
};
const connect = async () => {
  bridge = await startBridge(
    ledger,
    fixtures,
    (tx) => events.push(tx),
    (e) => infra.push(e.message),
    path.join(output, "transactions"),
  );
  const api = async (route, input) => {
    const response = await fetch(bridge.url + route, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Error("Bridge HTTP " + response.status);
    return response.json();
  };
  return { api, app: createTicketService(api, { recoverable: true }) };
};
try {
  await ledger.provision(fixtures);
  report.resources = structuredClone(ledger.resources);
  let app;
  if (crash) {
    await writeFile(
      path.join(output, "crash-context.json"),
      JSON.stringify({ fixtures, config }),
    );
    ledger.close();
    closedForRestart = true;
    await new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        ["PATH", ...operatorVariables]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]]),
      );
      const child = fork(
        new URL("./lab-recovery-crash-worker.mjs", import.meta.url),
        [output],
        { env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 180000);
      child.on("message", (m) => {
        if (typeof m?.transactionId === "string")
          report.originalTransactionId = m.transactionId;
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        report.crashSignal = signal;
        report.crashedPid = child.pid;
        if (signal === "SIGKILL" && report.originalTransactionId) resolve();
        else
          reject(
            Error("Live crash worker failed before confirmed HCS execution"),
          );
      });
    });
    report.steps.push(
      "purchase-confirmed",
      "process-killed-after-hcs-consensus",
    );
    ledger = new LiveLedger(config, path.join(output, "ledger"));
    await ledger.resume(fixtures);
    closedForRestart = false;
  } else {
    const execute = ledger.execute.bind(ledger);
    let lost = false;
    ledger.execute = async (op, before) => {
      const tx = await execute(op, before);
      if (op.type === "submitMessage" && tx.status === "SUCCESS" && !lost) {
        lost = true;
        report.originalTransactionId = tx.transactionId;
        throw Error("Injected lost response after real execution");
      }
      return tx;
    };
    ({ app } = await connect());
    must((await app.handle("buy")).ok, "Purchase failed");
    report.steps.push("purchase-confirmed");
    const initial = await app.handle("check-in");
    must(initial.pending === true, "Lost response did not stay pending");
    report.steps.push("check-in-response-lost");
    await bridge.stop();
    bridge = undefined;
    if (live) {
      ledger.close();
      closedForRestart = true;
      ledger = new LiveLedger(config, path.join(output, "ledger"));
      await ledger.resume(fixtures);
      closedForRestart = false;
    }
  }
  // The simulator represents the surviving network. Its state is not recreated.
  let restartWrites = 0;
  const resumedExecute = ledger.execute.bind(ledger);
  ledger.execute = async (...input) => {
    restartWrites++;
    return resumedExecute(...input);
  };
  const restarted = await connect();
  app = restarted.app;
  const retryCheckIn = () => createTicketService(restarted.api, { recoverable: true }).handle("check-in");
  report.steps.push("bridge-and-app-restarted");
  // Model temporarily unavailable receipts against the surviving real fixtures.
  // This fault is injected; successful reconciliation below uses the real SDK.
  const reconcile = ledger.reconcile.bind(ledger);
  ledger.reconcile = async () => null;
  const unavailable = await Promise.all(Array.from({ length: 8 }, retryCheckIn));
  must(unavailable.every(r => r.pending === true), "Missing receipts did not remain pending");
  must(restartWrites === 0, "Missing receipt triggered a blind resubmission");
  ledger.reconcile = reconcile;
  report.steps.push("injected-missing-receipts-stayed-pending-without-resubmission");
  const results = await Promise.all(
    Array.from({ length: 8 }, retryCheckIn),
  );
  must(
    results.every(
      (r) => r.ok && r.transactionId === report.originalTransactionId,
    ),
    "Receipt recovery did not confirm the original transaction",
  );
  must((await app.handle("buy")).ok, "Purchase receipt was not restored");
  must(restartWrites === 0, "Restart submitted another transaction");
  report.steps.push("eight-retries-reused-original-receipt");
  if (live) {
    const { TransactionId } = await import("@hiero-ledger/sdk");
    const transactionId = TransactionId.generate(ledger.resources.accounts.customer).toString();
    report.unsubmittedReceiptProbe = await probeUnsubmittedReceipt({ ledger, api: restarted.api, transactionId });
    must(restartWrites === 0, "Unsubmitted ID triggered a blind resubmission");
    const [account, start] = transactionId.split("@");
    const [seconds, nanos] = start.split(".");
    const mirrorId = `${account}-${seconds}-${nanos.padStart(9, "0")}`;
    const missing = await mirrorGet(
      config.mode === "local" ? config.mirrorUrl : "https://testnet.mirrornode.hedera.com",
      `/api/v1/transactions/${mirrorId}?nonce=0&scheduled=false`,
    );
    must(missing.status === 404 || (missing.status === 200 && Array.isArray(missing.body.transactions) && missing.body.transactions.length === 0), "Unsubmitted transaction must be absent from the independent mirror archive");
    report.unsubmittedReceiptProbe.mirror = missing;
    report.steps.push("real-receipt-archive-reads-kept-unsubmitted-id-pending-without-resubmission");
  }
  report.restartSubmissions = restartWrites;
  let ownership;
  let attendance;
  for (let i = 0; i < 30; i++) {
    ownership = await ledger.observe({
      type: "nftOwner",
      token: "ticket",
      serial: 1,
      account: "customer",
    });
    if (live) {
      const response = await mirrorGet(
        config.mode === "local" ? config.mirrorUrl : "https://testnet.mirrornode.hedera.com",
        `/api/v1/topics/${ledger.resources.topics.attendance}/messages?limit=100&order=asc`,
      );
      attendance = response.body.messages;
      if (response.body.links?.next) throw Error("Unexpected attendance pagination; uniqueness not proven");
    } else
      attendance = (
        await ledger.observe({
          type: "topicMessage",
          topic: "attendance",
          message: "ticket:1:customer",
        })
      ).evidence.messages;
    if (
      ownership.matches &&
      Array.isArray(attendance) &&
      attendance.length === 1
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  must(ownership.matches, "Independent ownership check failed");
  must(
    Array.isArray(attendance) && attendance.length === 1,
    "Expected exactly one independently observed HCS message",
  );
  if (live) must(
    Buffer.from(attendance[0].message, "base64").toString("utf8") === "ticket:1:customer" &&
      attendance[0].payer_account_id === ledger.resources.accounts.customer,
    "Independent HCS payload/payer check failed",
  );
  report.ownership = ownership;
  report.attendance = attendance;
  report.steps.push("independent-ledger-evidence-confirmed");
  report.passed = true;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  process.exitCode = 1;
} finally {
  await bridge?.stop();
  // If reattachment failed, retain the private recovery journal for inspection.
  if (!closedForRestart) {
    try {
      report.cleanupErrors = await ledger.cleanup();
    } catch {
      report.cleanupErrors = [
        "Cleanup failed; inspect private fixture recovery journal",
      ];
    }
  } else
    report.cleanupErrors = [
      "Resume failed; private fixture recovery journal retained",
    ];
  ledger.close();
  if (report.cleanupErrors.length || infra.length) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.events = events;
  report.infrastructureErrors = infra;
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      mode: report.mode,
      steps: report.steps,
      report: path.join(output, "report.json"),
      cleanupErrors: report.cleanupErrors,
    }),
  );
}
