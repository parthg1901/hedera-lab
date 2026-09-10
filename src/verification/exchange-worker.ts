import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store.js";
const suite = process.argv[2],
  workspace = process.argv[3];
const { Exchange } = await import(
  pathToFileURL(path.join(workspace, "engine.js")).href
);
const root = await mkdtemp(path.join(tmpdir(), "exchange-protocol-"));
await mkdir(root + "/app");
await writeFile(root + "/app/fixture", "protected fixture");
const store = new Store(root + "/store");
await store.start();
let settlements = 0,
  executions = 0;
const events: any[] = [];
const ex = new Exchange(
  store,
  [
    {
      id: "check",
      title: "fixture",
      description: "fixture",
      priceTinybar: "10",
      driver: "exchange-protocol",
      scenario: root + "/app/fixture",
      workspace: root + "/app",
    },
  ],
  "fixture",
  {
    mode: "simulated",
    async requirements() {
      return {};
    },
    async settle() {
      settlements++;
      await new Promise((r) => setTimeout(r, 20));
      if (suite === "payment-timeout")
        throw new Error("Settlement response lost");
      return { transaction: "simulated:payment", payer: "customer" };
    },
  },
  {
    async run() {
      executions++;
      return {
        infrastructureFailure: false,
        report: { passed: true, executed: 1, evidence: "independent-result" },
      };
    },
  },
);
const m = await ex.createMandate({
  target: "fixture",
  revision: "v1",
  required: ["check"],
  ceiling: "10",
});
const q = () =>
  ex.quote(m.mandateId, m.token, [{ pack: "check", repetitions: 1 }]);
function must(v: unknown, message: string) {
  if (!v) throw new Error(message);
}
try {
  if (suite === "payment-replay") {
    const quote = await q(),
      j = await ex.accept(quote.id, m.token);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        ex.pay(j.id, m.token, { proof: "same-payment" }),
      ),
    );
    await ex.idle();
    await ex.pay(j.id, m.token, { proof: "another-proof" });
    must(
      settlements === 1 && executions === 1,
      "Duplicate paid requests caused additional settlement or execution",
    );
    events.push({
      id: "single-settlement-for-replayed-job",
      status: "passed",
      evidence: { requests: 9, settlements, executions },
    });
  } else if (suite === "budget-race") {
    const a = await q(),
      b = await q();
    const results = await Promise.allSettled([
      ex.accept(a.id, m.token),
      ex.accept(b.id, m.token),
    ]);
    const v = await ex.view(m.mandateId, m.token);
    must(
      results.filter((r) => r.status === "fulfilled").length === 1 &&
        v.budget.reserved === "10",
      "Concurrent acceptance overspent the customer mandate",
    );
    events.push({
      id: "atomic-budget-reservation",
      status: "passed",
      evidence: { competingQuotes: 2, accepted: 1, ...v.budget },
    });
  } else if (suite === "payment-timeout") {
    const quote = await q(),
      j = await ex.accept(quote.id, m.token);
    try {
      await ex.pay(j.id, m.token, { proof: 1 });
    } catch {}
    try {
      await ex.pay(j.id, m.token, { proof: 2 });
    } catch {}
    const v = await ex.view(m.mandateId, m.token);
    must(
      (await ex.job(j.id, m.token)).state === "payment_unknown" &&
        v.budget.reserved === "10" &&
        settlements === 1 &&
        executions === 0,
      "Unknown settlement was retried, released, or delivered as paid",
    );
    events.push({
      id: "uncertain-payment-holds-reservation",
      status: "passed",
      evidence: {
        state: "payment_unknown",
        settlements,
        executions,
        ...v.budget,
      },
    });
  } else if (suite === "service-delivery") {
    const quote = await q(),
      j = await ex.accept(quote.id, m.token);
    must(executions === 0, "Job ran before payment");
    await ex.pay(j.id, m.token, { proof: 1 });
    await ex.idle();
    const result = await ex.job(j.id, m.token);
    must(
      result.state === "complete" &&
        result.report?.evidence === "independent-result" &&
        result.reportHash,
      "Paid result was not delivered with evidence",
    );
    events.push({
      id: "paid-result-and-report-hash",
      status: "passed",
      evidence: {
        state: result.state,
        reportHash: result.reportHash,
        executions,
      },
    });
  } else throw new Error("Unknown suite");
} catch (e) {
  events.push({
    id: suite,
    kind: "assertion",
    status: "failed",
    message: e instanceof Error ? e.message : "Unexpected error",
  });
} finally {
  await ex.idle();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    schemaVersion: 1,
    mode: "simulated",
    browserExecuted: false,
    infrastructureFailure: false,
    passed: events.every((e) => e.status === "passed"),
    events: events.map((e) => ({
      kind: "assertion",
      message: "verified",
      ...e,
    })),
  }),
);
