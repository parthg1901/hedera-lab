import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { TransactionJournal } from "../dist/lab/transactions.js";
import { SimulatedLedger } from "../dist/lab/simulated.js";
import { probeUnsubmittedReceipt } from "../scripts/lab-recovery-probe.mjs";

test("unsubmitted receipt probe preserves durable ID and uses real adapter reads without a write", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lab-missing-receipt-"));
  const fixtures = { accounts: { customer: { hbar: 1 } }, tokens: {}, topics: ["attendance"] };
  const ledger = new SimulatedLedger({ mirrorDelayMs: 0, rejectActors: [] });
  await ledger.provision(fixtures);
  const journal = new TransactionJournal(ledger, fixtures, directory);
  await journal.start();
  let submissions = 0;
  const execute = ledger.execute.bind(ledger);
  ledger.execute = async (...args) => { submissions++; return execute(...args); };
  const originalExecute = ledger.execute;
  const originalReconcile = ledger.reconcile;
  const api = (route, input) => route === "/receipt" ? journal.receipt(input.requestId) : journal.execute(input.requestId, input.operation, input.retryFailed);
  try {
    const report = await probeUnsubmittedReceipt({ ledger, api, transactionId: "unsubmitted-test-id" });
    assert.equal(report.status, "PENDING");
    assert.equal(report.observations.length, 2);
    assert.ok(report.observations.every(row => !row.found));
    assert.equal(submissions, 0);
    assert.equal(ledger.execute, originalExecute);
    assert.equal(ledger.reconcile, originalReconcile);
    const saved = JSON.parse(await readFile(path.join(directory, "transactions.json"), "utf8"));
    assert.deepEqual(saved.state.entries[report.requestId].attempts, [{ transactionId: "unsubmitted-test-id" }]);
    assert.equal((await ledger.observe({ type: "topicMessage", topic: "attendance", message: "receipt-probe:must-not-be-submitted" })).evidence.messages.length, 0);
  } finally { await journal.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unsubmitted probe restores the write method when reservation fails", async () => {
  const ledger = { execute: () => {} };
  const execute = ledger.execute;
  await assert.rejects(probeUnsubmittedReceipt({ ledger, api: async () => { throw Error("bridge unavailable"); }, transactionId: "unused" }), /bridge unavailable/);
  assert.equal(ledger.execute, execute);
});
