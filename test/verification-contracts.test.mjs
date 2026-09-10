import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FundingMeter } from "../dist/lab/funding.js";
import { executionTerms } from "../dist/verification/contracts.js";
import { loadConfig } from "../dist/verification/cli.js";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { hash } from "../dist/verification/model.js";

const config = await loadConfig(
  path.resolve("examples/verification/service-catalog.json"),
);
async function fixture(live = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "execution-contract-"));
  const store = new Store(dir);
  await store.start();
  const executor = live
    ? {
        readiness: async () => ({ available: true, reason: "test adapter" }),
        run: async () => ({
          infrastructureFailure: false,
          report: { passed: true },
        }),
      }
    : new LabExecutor(config.packs, path.join(dir, "jobs"));
  const ex = new Exchange(
    store,
    config.packs,
    config.target,
    new SimulatedPayment(),
    executor,
  );
  return {
    ex,
    dir,
    store,
    close: async () => {
      await ex.idle();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const mandate = (ex, extra = {}) =>
  ex.createMandate({
    target: config.target,
    revision: "user-commit-123",
    required: ["purchase"],
    ceiling: "10000000",
    ...extra,
  });

test("contract distinguishes simulated execution, payment and zero network funding", async () => {
  const f = await fixture();
  try {
    const m = await mandate(f.ex);
    const q = await f.ex.quote(m.mandateId, m.token, [
      { pack: "purchase", repetitions: 1 },
    ]);
    assert.equal(q.price, "1000000");
    assert.equal(q.settlement.serviceFeeTinybar, q.price);
    assert.equal(q.execution[0].terms.environment, "simulated");
    assert.equal(q.execution[0].terms.maximumExposureTinybar, "0");
    assert.equal(q.revision, "user-commit-123");
    const { contractHash, ...contract } = q;
    assert.equal(hash(contract), contractHash);
    assert.notEqual(hash({ ...contract, execution: [] }), contractHash);
  } finally {
    await f.close();
  }
});
test("unavailable live packages cannot be authorized or quoted; unknown environments rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      mandate(f.ex, { executionEnvironments: ["mainnet"] }),
      /execution environments/,
    );
    await assert.rejects(
      mandate(f.ex, {
        required: ["local-ledger"],
        executionEnvironments: ["local"],
      }),
      /unavailable/,
    );
    const m = await mandate(f.ex);
    await assert.rejects(
      f.ex.quote(m.mandateId, m.token, [
        { pack: "purchase", repetitions: 1 },
        { pack: "testnet-ledger", repetitions: 1 },
      ]),
      /outside the mandate/,
    );
  } finally {
    await f.close();
  }
});
test("mainnet package promises read-only approval preflight and zero submission funding", async () => {
  const t = await executionTerms(
    config.packs.find((p) => p.id === "approval-preflight"),
  );
  assert.equal(t.environment, "mainnet-preflight");
  assert.equal(t.access, "read-only");
  assert.equal(t.feeCeilingTinybar, "0");
  assert.ok(t.evidence.includes("No transaction submitted"));
});
test("live funding is separate from payment; cumulative and per-quote exposure cannot exceed authorization", async () => {
  const f = await fixture(true);
  try {
    const terms = await executionTerms(
      config.packs.find((p) => p.id === "testnet-ledger"),
    );
    const m = await mandate(f.ex, {
      required: ["testnet-ledger"],
      executionEnvironments: ["testnet"],
      executionCeilings: { testnet: terms.maximumExposureTinybar },
    });
    const q = await f.ex.quote(m.mandateId, m.token, [
      { pack: "testnet-ledger", repetitions: 1 },
    ]);
    assert.equal(q.price, "2000000");
    assert.equal(q.executionExposure.testnet, terms.maximumExposureTinybar);
    await assert.rejects(
      f.ex.quote(m.mandateId, m.token, [
        { pack: "testnet-ledger", repetitions: 2 },
      ]),
      /exceeds authorized/,
    );
    const second = await f.ex.quote(m.mandateId, m.token, [
      { pack: "testnet-ledger", repetitions: 1 },
    ]);
    const results = await Promise.allSettled([
      f.ex.accept(q.id, m.token),
      f.ex.accept(second.id, m.token),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const job = results.find((r) => r.status === "fulfilled").value;
    await f.ex.cancel(job.id, m.token);
    await f.ex.accept(
      results[0].status === "fulfilled" ? second.id : q.id,
      m.token,
    );
  } finally {
    await f.close();
  }
});
test("funding terms and readiness changes are rejected before settlement", async () => {
  const f = await fixture(true);
  try {
    const m = await mandate(f.ex, {
      required: ["testnet-ledger"],
      executionEnvironments: ["testnet"],
      executionCeilings: { testnet: "999999999999" },
    });
    const q = await f.ex.quote(m.mandateId, m.token, [
      { pack: "testnet-ledger", repetitions: 1 },
    ]);
    f.ex.executor.readiness = async () => ({
      available: false,
      reason: "worker offline",
    });
    await assert.rejects(f.ex.accept(q.id, m.token), /worker offline/);
    assert.equal(Object.keys((await f.store.read()).jobs).length, 0);
  } finally {
    await f.close();
  }
});
test("fee reservations serialize concurrent writes, persist before submission and preserve cleanup reserve", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "funding-meter-"));
  try {
    const t = {
      feeCeilingTinybar: "30",
      cleanupReserveTinybar: "10",
      perTransactionMaxTinybar: "10",
    };
    const meter = new FundingMeter(t, dir);
    const r = await Promise.allSettled(
      [1, 2, 3].map((n) => meter.reserve("0.0.1@100." + n, false)),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 2);
    await meter.reserve("0.0.1@100.4", true);
    await assert.rejects(meter.reserve("0.0.1@100.5", true), /ceiling/);
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "funding-journal.json"))).records
        .length,
      3,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("reconciliation records actual fees and recovered fixture funds from independent mirror rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "funding-evidence-"));
  const original = globalThis.fetch;
  try {
    const terms = {
      fundingNetwork: "testnet",
      fixtureFundingTinybar: "100",
      estimatedFeeTinybar: "8",
      feeCeilingTinybar: "30",
      cleanupReserveTinybar: "10",
      perTransactionMaxTinybar: "10",
    };
    const meter = new FundingMeter(terms, dir);
    await meter.reserve("0.0.1@100.1", false, { fundedTinybar: "100" });
    await meter.reserve("0.0.1@100.2", true, { sweepAccount: "0.0.2" });
    globalThis.fetch = async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      return Response.json({
        transactions: [
          {
            transaction_id: id,
            nonce: 0,
            scheduled: false,
            result: "SUCCESS",
            charged_tx_fee: 4,
            transfers: [{ account: "0.0.2", amount: -95 }],
          },
        ],
      });
    };
    const r = await meter.reconcile("https://mirror.example");
    assert.equal(r.status, "reconciled");
    assert.equal(r.actualFeeTinybar, "8");
    assert.equal(r.recoveredObservedTinybar, "95");
    assert.equal(r.unrecoveredTinybar, "5");
    globalThis.fetch = async () => Response.json({ transactions: [] });
    const missing = await meter.reconcile("https://mirror.example");
    assert.equal(missing.actualFeeTinybar, null);
    assert.equal(missing.unrecoveredTinybar, null);
    assert.equal(missing.status, "incomplete");
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent reduces live repetitions to fit execution funds independently of service price", async () => {
  const { fitExecutionExposure } = await import(
    "../dist/verification/contracts.js"
  );
  const terms = await executionTerms(
    config.packs.find((p) => p.id === "testnet-ledger"),
  );
  const packs = [{ id: "testnet-ledger", execution: terms }];
  assert.deepEqual(
    fitExecutionExposure(
      [{ pack: "testnet-ledger", repetitions: 3 }],
      ["testnet-ledger"],
      packs,
      { testnet: terms.maximumExposureTinybar },
    ),
    [{ pack: "testnet-ledger", repetitions: 1 }],
  );
  assert.throws(
    () =>
      fitExecutionExposure(
        [{ pack: "testnet-ledger", repetitions: 1 }],
        ["testnet-ledger"],
        packs,
        { testnet: "0" },
      ),
    /Mandatory testnet exposure/,
  );
});
