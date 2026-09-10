import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import {
  BlockyPayment,
  SimulatedPayment,
} from "../dist/verification/payment.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { runPurchaser } from "../dist/verification/agent.js";
import { HcsAuditor } from "../dist/verification/audit.js";
import { LiveLedger } from "../dist/lab/live.js";
const fullyLive = process.argv.includes("--fully-live");
const live = fullyLive || process.argv.includes("--testnet-payment");
const root = path.resolve(".harness/runs/verification-repair-" + randomUUID());
const workspace = path.join(root, "app");
await mkdir(root, { recursive: true });
await cp("examples/lab-ticketing", workspace, {
  recursive: true,
  filter: (p) => !p.includes(".harness"),
});
const file = path.join(workspace, "ticket-service.mjs");
const original = await readFile(file, "utf8");
await writeFile(
  file,
  original.replace(
    "const tx = await execute(purchaseId, { type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });",
    "const tx = {status:'SUCCESS',transactionId:'fabricated'};",
  ),
);
async function manifest() {
  const map = {};
  async function visit(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".harness") continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await visit(f);
      else
        map[path.relative(workspace, f)] = createHash("sha256")
          .update(await readFile(f))
          .digest("hex");
    }
  }
  await visit(workspace);
  return map;
}
const beforeService = await readFile(file, "utf8");
const beforeManifest = await manifest();
const packs = [
  {
    id: "purchase",
    title: "Independent purchase verification",
    description:
      "Browser actions with independent NFT ownership and HCS message checks; deterministic scenario.",
    priceTinybar: "1000000",
    scenario: path.join(
      workspace,
      fullyLive ? "scenarios/testnet-purchase.yaml" : "scenarios/purchase.yaml",
    ),
    workspace,
  },
];
const ledger = live
  ? new LiveLedger({ mode: "testnet" }, root + "/ledger")
  : undefined;
let store, server, ex;
const transcript = [];
console.log(
  JSON.stringify({
    output: root,
    mode: live ? "testnet-payment" : "simulated",
  }),
);
const timer = setInterval(
  () => console.log("Verification / agent repair experiment in progress..."),
  15000,
);
try {
  if (ledger)
    await ledger.provision({
      accounts: { verifier: { hbar: 1 } },
      tokens: {},
      topics: ["audit"],
    });
  store = new Store(root + "/service");
  await store.start();
  ex = new Exchange(
    store,
    packs,
    "ticketing",
    ledger
      ? new BlockyPayment(ledger.resources.accounts.verifier)
      : new SimulatedPayment(),
    new LabExecutor(packs, root + "/jobs"),
    ledger ? new HcsAuditor(ledger.resources.topics.audit) : undefined,
  );
  server = createExchangeServer(ex, "repair-experiment-customer-authorization");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await ex.recoverStartup();
  const m = await ex.createMandate({
    target: "ticketing",
    revision: "repair-experiment",
    required: ["purchase"],
    ceiling: "3000000",
  });
  const opts = {
    pay: true,
    planner: "codex",
    accountId: process.env.HEDERA_OPERATOR_ID,
    privateKey: process.env.HEDERA_OPERATOR_KEY,
    onEvent: (e) => {
      transcript.push(e);
      console.log(
        JSON.stringify(
          e.type === "delivery"
            ? { type: e.type, state: e.job.state, passed: e.job.report?.passed }
            : e.type === "counteroffer"
              ? e
              : {
                  type: e.type,
                  price: e.quote?.price,
                  transaction: e.transaction,
                },
        ),
      );
    },
  };
  const url = "http://127.0.0.1:" + server.address().port;
  const before = await runPurchaser(url, m.mandateId, m.token, opts);
  if (before.job.state !== "complete" || before.job.report.passed)
    throw new Error("Injected defect was not independently detected");
  const failures = before.job.report.runs.flatMap((r) =>
    r.report.events.filter((e) => e.status === "failed"),
  );
  const prompt =
    "Repair the ticketing application using the independent verifier findings below. Edit ONLY ticket-service.mjs. Do not change server.mjs, HTML, scenarios, or add files. The customer requires the NFT to actually reach the buyer and the HCS attendance record to exist. A success status fabricated in application code is not evidence. Inspect the service, correct the defect, and finish with a short explanation. Do not run package installation or contact live networks.\n" +
    JSON.stringify(failures);
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "LANG",
    "TMPDIR",
  ])
    if (process.env[key]) env[key] = process.env[key];
  await new Promise((resolve, reject) => {
    const child = execFile(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-C",
        workspace,
        prompt,
      ],
      { env, timeout: 180000, maxBuffer: 2000000 },
      async (error, stdout, stderr) => {
        await writeFile(root + "/builder-output.jsonl", stdout);
        await writeFile(root + "/builder-stderr.log", stderr);
        error ? reject(new Error("Builder agent failed")) : resolve();
      },
    );
    child.stdin.end();
  });
  const afterManifest = await manifest();
  const changed = [
    ...new Set([...Object.keys(beforeManifest), ...Object.keys(afterManifest)]),
  ].filter((k) => beforeManifest[k] !== afterManifest[k]);
  if (changed.length !== 1 || changed[0] !== "ticket-service.mjs")
    throw new Error(
      "Builder changed files outside the authorized service implementation",
    );
  const after = await runPurchaser(url, m.mandateId, m.token, opts);
  await ex.idle();
  const final = await ex.job(after.job.id, m.token);
  const budget = (await ex.view(m.mandateId, m.token)).budget;
  const summary = {
    mode: live ? "testnet-payment" : "simulated",
    planner: "codex",
    builder: "codex",
    ledgerMode: fullyLive ? "testnet" : "simulated",
    beforePassed: before.job.report.passed,
    afterPassed: final.report?.passed,
    changed,
    spentTinybar: budget.spent,
    ceilingTinybar: "3000000",
    paymentTransactions: [before.job.transaction, final.transaction],
    audit: final.audit,
  };
  await writeFile(
    root + "/evidence.json",
    JSON.stringify(
      { summary, before, after: { ...after, job: final }, transcript },
      null,
      2,
    ),
  );
  await writeFile(
    root + "/repair-files.json",
    JSON.stringify(
      { before: beforeService, after: await readFile(file, "utf8") },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary));
  if (!summary.afterPassed) process.exitCode = 1;
} finally {
  if (ex) await ex.idle();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (store) await store.close();
  if (ledger) {
    console.log(JSON.stringify({ cleanup: await ledger.cleanup() }));
    ledger.close();
  }
  clearInterval(timer);
}
