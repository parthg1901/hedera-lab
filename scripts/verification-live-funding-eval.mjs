/** Requires an explicitly supplied funded testnet operator. Service payment is
 * simulated; application transactions and spending reconciliation are real. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/verification/cli.js";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { createExchangeServer } from "../dist/verification/server.js";
if (!process.env.HEDERA_OPERATOR_ID || !process.env.HEDERA_OPERATOR_KEY)
  throw Error("Supply an authorized testnet operator through the environment");
const config = await loadConfig(
  path.resolve("examples/verification/service-catalog.json"),
);
const output = await mkdtemp(
  path.join(path.resolve(".harness/runs"), "live-funded-contract-"),
);
const store = new Store(path.join(output, "store"));
await store.start();
const ex = new Exchange(
  store,
  config.packs,
  config.target,
  new SimulatedPayment(),
  new LabExecutor(config.packs, path.join(output, "jobs")),
);
const admin = crypto.randomUUID();
const server = createExchangeServer(ex, admin);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
async function api(route, method = "GET", data, token = admin, extra = {}) {
  const r = await fetch(base + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...extra,
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error ?? "HTTP " + r.status);
  return b;
}
try {
  const m = await api("/mandates", "POST", {
    target: config.target,
    revision: "metered-testnet-user-run",
    required: ["testnet-ledger"],
    ceiling: "2000000",
    executionEnvironments: ["testnet"],
    executionCeilings: { testnet: "7000000000" },
  });
  const q = await api(
    "/quotes",
    "POST",
    {
      mandateId: m.mandateId,
      selection: [{ pack: "testnet-ledger", repetitions: 1 }],
    },
    m.token,
  );
  assert.equal(q.execution[0].terms.environment, "testnet");
  const j = await api("/quotes/" + q.id + "/accept", "POST", {}, m.token);
  await api("/jobs/" + j.id + "/pay", "POST", {}, m.token, {
    "payment-signature": Buffer.from(
      JSON.stringify({ simulation: true, quoteId: q.id }),
    ).toString("base64"),
  });
  await ex.idle();
  const job = await api("/jobs/" + j.id, "GET", undefined, m.token);
  const result = {
    label:
      "Real metered testnet application execution; simulated service payment",
    quote: q,
    job,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      state: job.state,
      passed: job.report?.passed,
      funding: job.report?.funding?.map(({ transactions, ...rest }) => rest),
    }),
  );
  assert.equal(job.state, "complete");
  assert.equal(job.report.passed, true);
  assert.equal(job.report.funding[0].status, "reconciled");
  assert.ok(BigInt(job.report.funding[0].actualFeeTinybar) > 0n);
  assert.ok(BigInt(job.report.funding[0].recoveredObservedTinybar) > 0n);
} finally {
  await ex.idle();
  await new Promise((r) => server.close(r));
  await store.close();
}
