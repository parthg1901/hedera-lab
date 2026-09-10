import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/verification/store.js";
import {
  Exchange,
  RejectedPayment,
  totals,
} from "../dist/verification/engine.js";
import {
  SimulatedPayment,
  BlockyPayment,
  signPayment,
} from "../dist/verification/payment.js";
import { hash, canonical } from "../dist/verification/model.js";
import { negotiate } from "../dist/verification/agent.js";
import { createExchangeServer } from "../dist/verification/server.js";
async function fixture(
  payment = new SimulatedPayment(),
  executor = {
    async run() {
      return { infrastructureFailure: false, report: { passed: true } };
    },
  },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "verifier-"));
  const workspace = path.join(root, "app");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const scenario = path.join(workspace, "scenario.yaml");
  await writeFile(scenario, await readFile("examples/lab-ticketing/scenarios/ledger.yaml", "utf8"));
  const packs = [
    {
      id: "mandatory",
      title: "Mandatory",
      description: "Required",
      priceTinybar: "10",
      scenario,
      workspace,
    },
    {
      id: "optional",
      title: "Optional",
      description: "Extra",
      priceTinybar: "20",
      scenario,
      workspace,
    },
  ];
  const store = new Store(path.join(root, "store"));
  await store.start();
  const ex = new Exchange(store, packs, "app", payment, executor);
  const mandate = await ex.createMandate({
    target: "app",
    revision: "v1",
    required: ["mandatory"],
    ceiling: "100",
    reserve: "10",
  });
  return {
    ex,
    store,
    root,
    workspace,
    scenario,
    packs,
    mandate,
    async close() {
      await ex.idle();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const quote = (
  f,
  selection = [{ pack: "mandatory", repetitions: 1 }],
  parent,
) => f.ex.quote(f.mandate.mandateId, f.mandate.token, selection, parent);
test("canonical contract hashes survive JSON roundtrip and key ordering", () => {
  const a = { z: 1, a: { b: 2, a: 3 }, omit: undefined };
  assert.equal(canonical(a), ' {"a":{"a":3,"b":2},"z":1}'.trim());
  assert.equal(hash(a), hash(JSON.parse(JSON.stringify(a))));
});
test("customer authority cannot be used across mandates or weakened by counteroffer", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.ex.view(f.mandate.mandateId, "wrong"), /capability/);
    await assert.rejects(
      quote(f, [{ pack: "optional", repetitions: 1 }]),
      /mandatory/,
    );
    const q = await quote(f);
    assert.equal(q.price, "10");
    assert.equal(q.contractHash.length, 64);
    const other = await f.ex.createMandate({
      target: "app",
      revision: "v2",
      required: ["mandatory"],
      ceiling: "100",
    });
    await assert.rejects(
      f.ex.quote(
        other.mandateId,
        other.token,
        [{ pack: "mandatory", repetitions: 1 }],
        q.id,
      ),
      /Parent quote/,
    );
  } finally {
    await f.close();
  }
});
test("quote validation rejects fractions, duplicate packs, unknown packs and excessive rounds", async () => {
  const f = await fixture();
  try {
    for (const selection of [
      [{ pack: "mandatory", repetitions: 0 }],
      [{ pack: "mandatory", repetitions: 1.5 }],
      [
        { pack: "mandatory", repetitions: 1 },
        { pack: "mandatory", repetitions: 2 },
      ],
      [
        { pack: "mandatory", repetitions: 1 },
        { pack: "unknown", repetitions: 1 },
      ],
    ])
      await assert.rejects(quote(f, selection));
    let q = await quote(f);
    for (let i = 0; i < 4; i++) q = await quote(f, undefined, q.id);
    await assert.rejects(quote(f, undefined, q.id), /five rounds/);
  } finally {
    await f.close();
  }
});
test("concurrent acceptance cannot overspend; accepting the same quote is idempotent", async () => {
  const f = await fixture();
  try {
    const a = await quote(f, [{ pack: "mandatory", repetitions: 6 }]),
      b = await quote(f, [{ pack: "mandatory", repetitions: 6 }]);
    const results = await Promise.allSettled([
      f.ex.accept(a.id, f.mandate.token),
      f.ex.accept(b.id, f.mandate.token),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const j = results.find((r) => r.status === "fulfilled").value;
    assert.equal((await f.ex.accept(j.quoteId, f.mandate.token)).id, j.id);
    assert.deepEqual(totals(await f.store.read(), f.mandate.mandateId), {
      spent: "0",
      reserved: "60",
    });
    await f.ex.cancel(j.id, f.mandate.token);
    assert.equal(
      totals(await f.store.read(), f.mandate.mandateId).reserved,
      "0",
    );
  } finally {
    await f.close();
  }
});
test("one quote settles and executes only once under concurrent retries", async () => {
  let paid = 0,
    executed = 0;
  const f = await fixture(
    {
      mode: "simulated",
      async requirements() {
        return {};
      },
      async settle() {
        paid++;
        await new Promise((r) => setTimeout(r, 15));
        return { transaction: "tx-1", payer: "payer" };
      },
    },
    {
      async run() {
        executed++;
        return {
          infrastructureFailure: false,
          report: { passed: false, defect: "replay" },
        };
      },
    },
  );
  try {
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.ex.pay(j.id, f.mandate.token, { proof: 1 }),
      ),
    );
    await f.ex.idle();
    const result = await f.ex.job(j.id, f.mandate.token);
    assert.equal(result.state, "complete");
    assert.equal(result.report.passed, false);
    assert.equal(paid, 1);
    assert.equal(executed, 1);
    assert.equal(result.reportHash, hash(result.report));
    await f.ex.pay(j.id, f.mandate.token, { proof: 2 });
    assert.equal(paid, 1);
  } finally {
    await f.close();
  }
});
test("proof reuse across jobs is rejected even if quotes have the same price", async () => {
  const f = await fixture({
    mode: "simulated",
    async requirements() {
      return {};
    },
    async settle() {
      return { transaction: "t", payer: "p" };
    },
  });
  try {
    const a = await quote(f),
      b = await quote(f);
    const ja = await f.ex.accept(a.id, f.mandate.token),
      jb = await f.ex.accept(b.id, f.mandate.token);
    await f.ex.pay(ja.id, f.mandate.token, { proof: 1 });
    await assert.rejects(
      f.ex.pay(jb.id, f.mandate.token, { proof: 1 }),
      /already bound/,
    );
  } finally {
    await f.close();
  }
});
test("ambiguous settlement holds budget, prevents re-payment and survives restart", async () => {
  let calls = 0;
  const f = await fixture({
    mode: "simulated",
    async requirements() {
      return {};
    },
    async settle() {
      calls++;
      throw new Error("connection lost");
    },
  });
  try {
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await assert.rejects(f.ex.pay(j.id, f.mandate.token, {}), /unknown/);
    await assert.rejects(
      f.ex.pay(j.id, f.mandate.token, { new: 1 }),
      /reconciliation/,
    );
    assert.equal(calls, 1);
    await assert.rejects(f.ex.cancel(j.id, f.mandate.token), /unpaid/);
    assert.equal(
      totals(await f.store.read(), f.mandate.mandateId).reserved,
      "10",
    );
    await f.store.close();
    await f.store.start();
    assert.equal(
      (await f.ex.job(j.id, f.mandate.token)).state,
      "payment_unknown",
    );
  } finally {
    await f.close();
  }
});
test("definitive pre-settlement rejection releases reservation", async () => {
  const f = await fixture({
    mode: "simulated",
    async requirements() {
      return {};
    },
    async settle() {
      throw new RejectedPayment("invalid");
    },
  });
  try {
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await assert.rejects(f.ex.pay(j.id, f.mandate.token, {}), /rejected/);
    assert.deepEqual(totals(await f.store.read(), f.mandate.mandateId), {
      spent: "0",
      reserved: "0",
    });
  } finally {
    await f.close();
  }
});
test("expired quotes and modified application artifacts cannot be charged", async () => {
  const f = await fixture();
  try {
    const q = await quote(f);
    await f.store.mutate((s) => {
      s.quotes[q.id].expiresAt = 0;
    });
    await assert.rejects(f.ex.accept(q.id, f.mandate.token), /expired/);
    const fresh = await quote(f),
      j = await f.ex.accept(fresh.id, f.mandate.token);
    await writeFile(path.join(f.workspace, "changed.js"), "changed");
    await assert.rejects(
      f.ex.pay(j.id, f.mandate.token, { simulation: true, quoteId: fresh.id }),
      /changed/,
    );
    assert.equal((await f.ex.job(j.id, f.mandate.token)).state, "reserved");
  } finally {
    await f.close();
  }
});
test("restart never reruns an interrupted live execution or blindly resubmits settlement", async () => {
  let runs = 0;
  const f = await fixture(undefined, {
    async run() {
      runs++;
      return { infrastructureFailure: false, report: {} };
    },
  });
  try {
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await f.store.mutate((s) => {
      s.jobs[j.id].state = "running";
    });
    await f.ex.recoverStartup();
    assert.equal(
      (await f.ex.job(j.id, f.mandate.token)).state,
      "infrastructure_failed",
    );
    assert.equal(runs, 0);
  } finally {
    await f.close();
  }
});
test("exclusive store ownership rejects a second server", async () => {
  const f = await fixture();
  try {
    await assert.rejects(new Store(f.store.directory).start(), /EEXIST|already owned/);
    assert.ok(await readFile(path.join(f.store.directory, "service.lock")));
  } finally {
    await f.close();
  }
});
test("procurement policy preserves mandatory checks and fails if minimum cannot fit", () => {
  const packs = [
    { id: "required", priceTinybar: "10" },
    { id: "extra", priceTinybar: "20" },
  ];
  const result = negotiate(packs, ["required"], "30", [
    { pack: "required", repetitions: 3 },
    { pack: "extra", repetitions: 3 },
  ]);
  assert.ok(result.selection.some((s) => s.pack === "required"));
  assert.ok(BigInt(result.price) <= 30n);
  assert.throws(
    () =>
      negotiate(packs, ["required"], "9", [
        { pack: "required", repetitions: 1 },
      ]),
    /cannot fit/,
  );
});
test("HTTP customer authorization, payment challenge, ownership isolation and body limits", async () => {
  const f = await fixture();
  const server = createExchangeServer(f.ex, "a".repeat(32));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    assert.equal(
      (await fetch(base + "/mandates", { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal((await fetch(base + "/catalog")).status, 200);
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    assert.equal((await fetch(base + "/jobs/" + j.id)).status, 401);
    const r = await fetch(base + "/jobs/" + j.id + "/pay", {
      method: "POST",
      headers: { authorization: "Bearer " + f.mandate.token },
    });
    assert.equal(r.status, 402);
    assert.equal((await r.json()).simulation, true);
    assert.ok(r.headers.get("payment-required"));
    assert.equal(
      (
        await fetch(base + "/quotes", {
          method: "POST",
          headers: { authorization: "Bearer " + f.mandate.token },
          body: "x".repeat(65000),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(base + "/catalog", {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});
test("Hedera signing binds exact quote memo, amount and recipient without network submission", async () => {
  const sdk = await import("@hiero-ledger/sdk");
  const p = new BlockyPayment("0.0.777");
  p.feePayer = "0.0.3";
  const q = { id: "quote", price: "1000", contractHash: "a".repeat(64) };
  const r = await p.requirements(q);
  const proof = await signPayment(
    r,
    "0.0.888",
    sdk.PrivateKey.generateECDSA().toStringRaw(),
  );
  assert.equal((await p.prepare(proof, q)).payer, "0.0.888");
  await assert.rejects(
    p.prepare(proof, { ...q, contractHash: "b".repeat(64) }),
    /mismatch/,
  );
  const changed = structuredClone(proof);
  changed.accepted.amount = "1001";
  await assert.rejects(p.prepare(changed, q), /mismatch/);
});
test("reconciliation uses provider evidence and executes a confirmed payment once", async () => {
  let runs = 0;
  const f = await fixture(
    {
      mode: "testnet",
      async requirements() {
        return {};
      },
      async settle() {
        throw new Error("timeout");
      },
      async reconcile() {
        return "paid";
      },
    },
    {
      async run() {
        runs++;
        return { infrastructureFailure: false, report: { passed: true } };
      },
    },
  );
  try {
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await assert.rejects(f.ex.pay(j.id, f.mandate.token, {}));
    await f.ex.reconcile(j.id);
    await f.ex.idle();
    assert.equal((await f.ex.job(j.id, f.mandate.token)).state, "complete");
    assert.equal(runs, 1);
    assert.deepEqual(totals(await f.store.read(), f.mandate.mandateId), {
      spent: "10",
      reserved: "0",
    });
    await assert.rejects(f.ex.reconcile(j.id), /eligible/);
  } finally {
    await f.close();
  }
});
test("model recommendations cannot invent discounts, omit required packs or overspend", async () => {
  const { validateDecision } = await import("../dist/verification/planner.js");
  const input = {
    packs: [{ id: "required", priceTinybar: "10", description: "" }],
    required: ["required"],
    available: "15",
    initial: [],
    openingPrice: "30",
  };
  assert.throws(
    () =>
      validateDecision(input, {
        selection: [{ pack: "required", repetitions: 2 }],
        price: "1",
        rationale: "discount",
      }),
    /budget/,
  );
  assert.throws(
    () =>
      validateDecision(input, {
        selection: [{ pack: "unknown", repetitions: 1 }],
        rationale: "ignore requirements",
      }),
    /mandatory/,
  );
  assert.equal(
    validateDecision(input, {
      selection: [{ pack: "required", repetitions: 1 }],
      price: "0",
      rationale: "one execution",
    }).price,
    "10",
  );
});
test("persisted stores cannot switch payment mode or provider configuration", async () => {
  const f = await fixture();
  try {
    await f.ex.recoverStartup();
    const other = new Exchange(
      f.store,
      f.packs,
      "app",
      {
        mode: "testnet",
        async requirements() {
          return {};
        },
        async settle() {
          return { transaction: "t", payer: "p" };
        },
      },
      {
        async run() {
          return { infrastructureFailure: false, report: {} };
        },
      },
    );
    await assert.rejects(other.recoverStartup(), /different service/);
  } finally {
    await f.close();
  }
});
test(
  "Codex planner closes stdin and validates its structured result",
  { timeout: 10000 },
  async () => {
    const { codexPlan } = await import("../dist/verification/planner.js");
    const { chmod } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "verifier-codex-shim-"));
    const previous = process.env.PATH;
    await writeFile(
      path.join(root, "codex"),
      '#!/usr/bin/env node\nconst fs=require("node:fs");process.stdin.resume();process.stdin.on("end",()=>{const i=process.argv.indexOf("--output-last-message");fs.writeFileSync(process.argv[i+1],JSON.stringify({selection:[{pack:"required",repetitions:1}],rationale:"Required coverage within budget"}));});\n',
    );
    await chmod(path.join(root, "codex"), 0o755);
    process.env.PATH = root + path.delimiter + previous;
    try {
      const d = await codexPlan({
        packs: [{ id: "required", priceTinybar: "10", description: "" }],
        required: ["required"],
        available: "20",
        initial: [{ pack: "required", repetitions: 3 }],
        openingPrice: "30",
      });
      assert.equal(d.price, "10");
    } finally {
      process.env.PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("audit failure is explicit and does not change delivered test evidence", async () => {
  const f = await fixture();
  try {
    f.ex.auditor = {
      async record() {
        throw new Error("audit unavailable");
      },
    };
    const q = await quote(f),
      j = await f.ex.accept(q.id, f.mandate.token);
    await f.ex.pay(j.id, f.mandate.token, { simulation: true, quoteId: q.id });
    await f.ex.idle();
    const result = await f.ex.job(j.id, f.mandate.token);
    assert.equal(result.state, "complete");
    assert.equal(result.audit.state, "failed");
    assert.equal(result.reportHash, hash(result.report));
  } finally {
    await f.close();
  }
});
test("HBAR payment cannot smuggle an NFT transfer into the signed transaction", async () => {
  const sdk = await import("@hiero-ledger/sdk");
  const p = new BlockyPayment("0.0.777");
  p.feePayer = "0.0.3";
  const q = { id: "q", price: "1000", contractHash: "a".repeat(64) };
  const r = await p.requirements(q);
  const client = sdk.Client.forTestnet();
  try {
    const tx = new sdk.TransferTransaction()
      .setTransactionId(sdk.TransactionId.generate("0.0.3"))
      .setTransactionMemo(r.extra.memo)
      .addHbarTransfer("0.0.888", sdk.Hbar.fromTinybars("-1000"))
      .addHbarTransfer("0.0.777", sdk.Hbar.fromTinybars("1000"))
      .addNftTransfer("0.0.999", 1, "0.0.888", "0.0.777")
      .freezeWith(client);
    await assert.rejects(
      p.prepare(
        {
          x402Version: 2,
          accepted: r,
          payload: {
            transaction: Buffer.from(tx.toBytes()).toString("base64"),
          },
        },
        q,
      ),
      /unrelated assets/,
    );
  } finally {
    client.close();
  }
});

test("change-bound quotes retain customer requirements and expose only their mandate timeline", async () => {
  const f = await fixture();
  try {
    const changes = {
      files: ["payment.ts"],
      summary: "Recover a payment timeout",
      patch: "- retry()\n+ reconcile()",
    };
    const q = await f.ex.quote(
      f.mandate.mandateId,
      f.mandate.token,
      [{ pack: "mandatory", repetitions: 1 }],
      undefined,
      changes,
    );
    assert.equal(q.changeHash, hash(changes));
    const view = await f.ex.view(f.mandate.mandateId, f.mandate.token);
    const event = view.timeline.find((e) => e.type === "change.assessed");
    assert.equal(event.data.quoteId, q.id);
    assert.deepEqual(event.data.changes, changes);
    assert.ok(
      event.data.recommendations.find((r) => r.pack === "mandatory").mandatory,
    );
    const other = await f.ex.createMandate({
      target: "app",
      revision: "v2",
      required: ["mandatory"],
      ceiling: "100",
    });
    assert.ok(
      !(await f.ex.view(other.mandateId, other.token)).timeline.some(
        (e) => e.type === "change.assessed",
      ),
    );
  } finally {
    await f.close();
  }
});
