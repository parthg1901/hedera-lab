import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { runPurchaser } from "../dist/verification/agent.js";
const output = path.resolve(
  process.argv[2] ?? ".harness/runs/verification-benchmark-" + randomUUID(),
);
await mkdir(output, { recursive: true });
const cases = [
  { id: "correct", expectedPass: true, mutate: (s) => s },
  {
    id: "fake-transfer",
    expectedPass: false,
    mutate: (s) =>
      s.replace(
        "const tx = await execute(purchaseId, { type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });",
        "const tx = {status:'SUCCESS',transactionId:'fabricated'};",
      ),
  },
  {
    id: "fake-attendance",
    expectedPass: false,
    mutate: (s) =>
      s.replace(
        "const tx = await execute(checkInId, { type: 'submitMessage', actor: 'customer', topic: 'attendance', message: 'ticket:1:customer' });",
        "const tx = {status:'SUCCESS',transactionId:'fabricated'};",
      ),
  },
  {
    id: "missing-association",
    expectedPass: false,
    mutate: (s) =>
      s.replace(
        "const association = await execute('ticket:customer:association', { type: 'associate', actor: 'customer', token: 'ticket' });",
        "const association = {status:'SUCCESS'};",
      ),
  },
];
const results = [];
for (const c of cases) {
  const dir = path.join(output, c.id),
    workspace = path.join(dir, "app");
  await cp("examples/lab-ticketing", workspace, {
    recursive: true,
    filter: (p) => !p.includes(".harness"),
  });
  const file = path.join(workspace, "ticket-service.mjs");
  await writeFile(file, c.mutate(await readFile(file, "utf8")));
  const packs = [
    {
      id: "purchase",
      title: "Independent purchase verification",
      description: "Browser and independent ledger assertions",
      priceTinybar: "1000000",
      scenario: path.join(workspace, "scenarios/purchase.yaml"),
      workspace,
    },
  ];
  const store = new Store(path.join(dir, "service"));
  await store.start();
  const ex = new Exchange(
    store,
    packs,
    "ticketing",
    new SimulatedPayment(),
    new LabExecutor(packs, path.join(dir, "jobs")),
  );
  const server = createExchangeServer(ex, "benchmark-customer-authorization");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const m = await ex.createMandate({
      target: "ticketing",
      revision: c.id,
      required: ["purchase"],
      ceiling: "1000000",
    });
    const transcript = [];
    const result = await runPurchaser(
      "http://127.0.0.1:" + server.address().port,
      m.mandateId,
      m.token,
      { pay: true, onEvent: (e) => transcript.push(e) },
    );
    const r = result.job.report.runs[0].report;
    const ui = r.events.find((e) => e.id === "purchase-ui");
    const summary = {
      case: c.id,
      expectedPass: c.expectedPass,
      passed: r.passed,
      infrastructureFailure: r.infrastructureFailure,
      uiReportedPurchaseSuccess: ui?.status === "passed",
      failedChecks: r.events
        .filter((e) => e.status === "failed")
        .map((e) => e.id),
      openingPrice: transcript.find((e) => e.type === "opening_quote").quote
        .price,
      acceptedPrice: result.quote.price,
      reportHash: result.job.reportHash,
    };
    results.push(summary);
    await writeFile(
      path.join(dir, "evidence.json"),
      JSON.stringify({ summary, transcript, result }, null, 2),
    );
    console.log(JSON.stringify(summary));
    if (r.passed !== c.expectedPass || r.infrastructureFailure)
      process.exitCode = 1;
  } finally {
    await ex.idle();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await store.close();
  }
  // Keep evidence, remove mutable copied code and private service capabilities.
  await rm(workspace, { recursive: true, force: true });
}
await writeFile(
  path.join(output, "summary.json"),
  JSON.stringify(
    {
      scope:
        "Controlled injected defects; deterministic purchasing agent, simulated payment and ledger, real Chromium. Not an LLM repair benchmark.",
      results,
    },
    null,
    2,
  ),
);
console.log("Evidence: " + output);
