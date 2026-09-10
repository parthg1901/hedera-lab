/** Read-only audit of real archived testnet operations, not a new paid/live run. */
import { readFile, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { FundingMeter } from "../dist/lab/funding.js";
const source = process.argv[2];
if (!source) throw Error("Usage: node scripts/verification-funding-audit.mjs <saved-testnet-report.json>");
const report = JSON.parse(await readFile(source));
const ids = [
  ...new Set(
    report.events
      .filter((e) => e.kind === "transaction")
      .map((e) => e.evidence?.transactionId)
      .filter(Boolean),
  ),
];
assert.ok(ids.length > 0);
const meter = new FundingMeter(
  {
    fundingNetwork: "testnet",
    fixtureFundingTinybar: "0",
    estimatedFeeTinybar: "0",
    feeCeilingTinybar: "10000000000",
    cleanupReserveTinybar: "1000000000",
    perTransactionMaxTinybar: "200000000",
  },
  await mkdtemp(path.join(os.tmpdir(), "archived-funding-")),
);
for (const id of ids) await meter.reserve(id, false);
const accounting = await meter.reconcile(
  "https://testnet.mirrornode.hedera.com",
);
assert.equal(accounting.status, "reconciled");
assert.ok(BigInt(accounting.actualFeeTinybar) > 0n);
const result = {
  label:
    "Read-only fee audit of previously executed real testnet operations; not a new live execution and not full fixture accounting",
  source,
  checkedAt: new Date().toISOString(),
  accounting,
};
await mkdir(".harness/runs/execution-contract-walkthrough", {
  recursive: true,
});
await writeFile(
  ".harness/runs/execution-contract-walkthrough/archived-testnet-fees.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    transactions: ids.length,
    actualFeeTinybar: accounting.actualFeeTinybar,
  }),
);
