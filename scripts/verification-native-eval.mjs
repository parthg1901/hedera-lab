import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { runPurchaser } from "../dist/verification/agent.js";
const root = path.resolve(
  process.argv[2] ?? ".harness/runs/native-evaluation-" + randomUUID(),
);
await mkdir(root, { recursive: true });
const common = `Implement ticket-service.mjs from scratch, exporting createTicketService(ledger), returning an object with async handle(action). Build an actual ticket purchase/check-in service. The supplied server and HTML are fixed. Handle 'buy' and 'check-in'. Adapter calls are await ledger('/execute', operation) -> {status,transactionId}; await ledger('/observe', assertion) -> {matches,evidence}. Operations: {type:'associate',actor:'customer',token:'ticket'}, {type:'transferNft',actor:'organizer',to:'customer',token:'ticket',serial:1}, {type:'submitMessage',actor:'customer',topic:'attendance',message:'ticket:1:customer'}. Ownership assertion: {type:'nftOwner',token:'ticket',serial:1,account:'customer'}. Status SUCCESS means consensus accepted; mirror observation may lag. TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT is acceptable for association. USER_REJECTED must not cause later transaction submissions. Successful buy returns {ok:true,message:'Ticket purchased'}, successful check-in returns {ok:true,message:'Checked in'}. A wallet rejection returns {ok:false,message:'Wallet rejected'}. Check-in requires a successfully purchased ticket. Never fabricate successful transactions. Unknown actions return a failure. Write self-test.mjs using Node's built-in assert to test your implementation. Run node self-test.mjs before declaring complete. No npm dependencies or installation. Only create ticket-service.mjs and self-test.mjs; do not edit existing files or access other project workspaces. Do not inspect or seek evaluator tests. The adapter is injected, so no network or wallet credentials are needed.`;
const cases = [
  {
    id: "basic",
    requirement:
      "Implement the basic sequential purchase and check-in workflow.",
    packs: ["purchase"],
  },
  {
    id: "retry-safe",
    requirement:
      "In addition, repeated purchases and repeated check-ins must return the existing successful result without a second NFT transfer or second HCS message. Failed operations must not be marked complete.",
    packs: ["purchase", "purchase-replay", "checkin-replay"],
  },
  {
    id: "resilient",
    requirement:
      "In addition, handle concurrent purchase calls without duplicate NFT submissions. Handle a transfer whose consensus succeeded but whose response was lost: the adapter can throw after executing the transfer. A later retry must use the ownership observation to recover a confirmed purchase without blindly submitting the transfer again. A first-call uncertainty error is permitted; once ownership is visible, a retry must return purchase success. Do not treat a lagging observation after known SUCCESS as a failed purchase.",
    packs: ["purchase", "concurrent-purchase", "timeout-recovery"],
  },
];
await writeFile(
  root + "/protocol.json",
  JSON.stringify(
    {
      registeredAt: new Date().toISOString(),
      method:
        "Three independently generated implementations from fixed task briefs. No injected mutations. All cases reported. One evidence-guided repair allowed per failing case.",
      cases: cases.map((c) => ({
        ...c,
        prompt: common + "\n" + c.requirement,
      })),
    },
    null,
    2,
  ),
);
const catalog = JSON.parse(
  await readFile("examples/verification/risk-catalog.json", "utf8"),
);
const results = [];
const env = {};
for (const k of [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "LANG",
  "TMPDIR",
])
  if (process.env[k]) env[k] = process.env[k];
const execute = (cmd, args, cwd, timeout = 180000) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd, env, timeout, maxBuffer: 2000000 },
      (error, stdout, stderr) =>
        resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
async function manifest(dir) {
  const m = {};
  for (const f of await readdir(dir)) {
    const b = await readFile(path.join(dir, f));
    m[f] = createHash("sha256").update(b).digest("hex");
  }
  return m;
}
const timer = setInterval(
  () =>
    console.log("Native generation / independent evaluation in progress..."),
  15000,
);
try {
  for (const c of cases) {
    const dir = path.join(root, c.id),
      workspace = path.join(dir, "app");
    await mkdir(workspace, { recursive: true });
    for (const file of ["server.mjs", "index.html"])
      await copyFile(
        "examples/lab-ticketing/" + file,
        path.join(workspace, file),
      );
    const protectedManifest = await manifest(workspace);
    await writeFile(dir + "/prompt.txt", common + "\n" + c.requirement);
    const generated = await execute(
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
        common + "\n" + c.requirement,
      ],
      workspace,
    );
    await writeFile(
      dir + "/generation.json",
      JSON.stringify(generated, null, 2),
    );
    const authored = await manifest(workspace);
    const tampered = Object.keys(protectedManifest).some(
      (f) => authored[f] !== protectedManifest[f],
    );
    const selfTest = await execute(
      process.execPath,
      ["self-test.mjs"],
      workspace,
      30000,
    );
    await writeFile(dir + "/self-test.json", JSON.stringify(selfTest, null, 2));
    const packs = catalog.packs
      .filter((p) => c.packs.includes(p.id))
      .map((p) => ({
        ...p,
        workspace,
        scenario: path.resolve("examples/verification", p.scenario),
      }));
    const store = new Store(dir + "/service");
    await store.start();
    const ex = new Exchange(
      store,
      packs,
      "native-" + c.id,
      new SimulatedPayment(),
      new LabExecutor(packs, dir + "/jobs"),
    );
    const server = createExchangeServer(
      ex,
      "native-evaluation-customer-authorization",
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const ceiling =
        packs.reduce((n, p) => n + BigInt(p.priceTinybar), 0n) * 2n;
      const m = await ex.createMandate({
        target: "native-" + c.id,
        revision: "fresh-generation",
        required: c.packs,
        ceiling: ceiling.toString(),
      });
      const opts = { pay: true, repetitions: 1 };
      const url = "http://127.0.0.1:" + server.address().port;
      const before = await runPurchaser(url, m.mandateId, m.token, opts);
      await writeFile(dir + "/before.json", JSON.stringify(before, null, 2));
      let after,
        repair,
        repairChanged = [];
      if (
        !tampered &&
        before.job.state === "complete" &&
        !before.job.report.passed
      ) {
        const failures = before.job.report.runs.flatMap((r) =>
          r.report.events.filter((e) => e.status === "failed"),
        );
        repair = await execute(
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
            "Independent verification found these failures. Repair ONLY ticket-service.mjs. Do not modify tests or existing scaffold. Run your existing self-test. Requirements still apply: " +
              c.requirement +
              "\n" +
              JSON.stringify(failures),
          ],
          workspace,
        );
        await writeFile(dir + "/repair.json", JSON.stringify(repair, null, 2));
        const repaired = await manifest(workspace);
        repairChanged = [
          ...new Set([...Object.keys(authored), ...Object.keys(repaired)]),
        ].filter((f) => authored[f] !== repaired[f]);
        if (repairChanged.every((f) => f === "ticket-service.mjs")) {
          after = await runPurchaser(url, m.mandateId, m.token, opts);
          await writeFile(dir + "/after.json", JSON.stringify(after, null, 2));
        }
      }
      const summary = {
        case: c.id,
        generationExit: generated.exitCode,
        scaffoldUnchanged: !tampered,
        selfTestExit: selfTest.exitCode,
        beforePassed: before.job.report?.passed,
        infrastructureFailure: before.job.state !== "complete",
        failedChecks: before.job.report?.runs.flatMap((r) =>
          r.report.events
            .filter((e) => e.status === "failed")
            .map((e) => ({ pack: r.pack, id: e.id, message: e.message })),
        ),
        repairAttempted: Boolean(repair),
        repairChanged,
        afterPassed: after?.job.report?.passed ?? null,
        spentTinybar: (await ex.view(m.mandateId, m.token)).budget.spent,
        artifacts: authored,
      };
      results.push(summary);
      console.log(JSON.stringify(summary));
    } finally {
      await ex.idle();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await store.close();
    }
    await writeFile(
      root + "/summary.json",
      JSON.stringify(
        {
          scope:
            "No injected defects; one fresh generation per brief; policy procurement, simulated settlement and ledger; browser and application execution real. Descriptive sample, not a statistical model comparison.",
          results,
        },
        null,
        2,
      ),
    );
  }
} finally {
  clearInterval(timer);
  console.log("Evidence: " + root);
}
