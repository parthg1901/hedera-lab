/** Live hosted-worker buyer test. Reads API admin token from stdin; payer key stays
 * in this client environment. Requires an already deployed funded worker. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { runPurchaser } from "../dist/verification/agent.js";
const base = process.env.VERIFIER_URL ?? "http://127.0.0.1:4318";
const admin = (await readFile("/dev/stdin", "utf8")).trim();
if (!process.env.HEDERA_OPERATOR_ID || !process.env.HEDERA_OPERATOR_KEY)
  throw Error(
    "Supply authorized testnet payer credentials outside the service",
  );
async function api(route, method = "GET", body, token = admin) {
  const r = await fetch(base + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error ?? "HTTP " + r.status);
  return b;
}
const catalog = await api("/catalog");
assert.equal(catalog.paymentMode, "testnet");
assert.equal(
  catalog.packs.find((p) => p.id === "testnet-ledger").availability.available,
  true,
);
const mandate = await api("/mandates", "POST", {
  target: catalog.target,
  revision: "hosted-testnet-worker-user-run",
  required: ["testnet-ledger"],
  ceiling: "2000000",
  executionEnvironments: ["testnet"],
  executionCeilings: { testnet: "7000000000" },
});
const output = ".harness/runs/hosted-worker-" + Date.now();
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(output + "/capability.json", JSON.stringify(mandate), {
  mode: 0o600,
});
const result = await runPurchaser(base, mandate.mandateId, mandate.token, {
  pay: true,
  planner: "policy",
  allocation: "2000000",
  accountId: process.env.HEDERA_OPERATOR_ID,
  privateKey: process.env.HEDERA_OPERATOR_KEY,
});
await writeFile(
  output + "/report.json",
  JSON.stringify(
    {
      paymentMode: "testnet",
      executionMode: "testnet",
      quote: result.quote,
      job: result.job,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output,
    state: result.job?.state,
    passed: result.job?.report?.passed,
    transaction: result.job?.transaction,
    funding: result.job?.report?.funding?.map(({ transactions, ...r }) => r),
  }),
);
assert.equal(result.job.state, "complete");
assert.equal(result.job.report.passed, true);
assert.equal(result.job.report.worker.transport, "private-unix-socket");
assert.equal(result.job.report.funding[0].status, "reconciled");
