import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { runPurchaser } from "../dist/verification/agent.js";
const root = path.resolve(
  process.argv[2] ?? ".harness/runs/preflight-service-" + randomUUID(),
);
const workspace = root + "/app";
await mkdir(workspace, { recursive: true });
const protocol = JSON.parse(
  await readFile("examples/preflight/evaluation.json", "utf8"),
);
const broken = protocol.cases.find(
  (c) => c.id === "different-spender",
).proposal;
const correction = JSON.parse(
  await readFile(
    process.argv[3] ??
      ".harness/runs/preflight-evaluation-1/agents/05-lab.json",
    "utf8",
  ),
).result;
if (!correction.repairPassed || correction.case !== "different-spender")
  throw Error(
    "Requires a successful preserved model correction for the same case",
  );
for (const [f, v] of [
  ["policy.json", protocol.policy],
  ["proposal.json", broken],
  ["scenario.json", { policy: "policy.json", proposal: "proposal.json" }],
])
  await writeFile(workspace + "/" + f, JSON.stringify(v, null, 2));
const packs = [
  {
    id: "approval-preflight",
    title: "Mainnet approval verification",
    description:
      "Customer-bound SAUCE approval checks with historical mainnet simulation and gas estimate",
    workspace,
    scenario: workspace + "/scenario.json",
    driver: "mainnet-preflight",
    priceTinybar: "1000000",
    risks: ["payment", "ownership"],
  },
];
const store = new Store(root + "/service");
await store.start();
const exchange = new Exchange(
  store,
  packs,
  "sauce-approval-mainnet",
  new SimulatedPayment(),
  new LabExecutor(packs, root + "/jobs"),
);
const server = createExchangeServer(
  exchange,
  "preflight-demo-customer-authorization",
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const m = await exchange.createMandate({
    target: "sauce-approval-mainnet",
    revision: "preflight-demo",
    required: ["approval-preflight"],
    ceiling: "3000000",
  });
  const url = "http://127.0.0.1:" + server.address().port,
    opts = {
      pay: true,
      repetitions: 1,
      changes: {
        files: ["proposal.json"],
        summary: "SAUCE approval for the customer-authorized spender",
      },
    };
  const before = await runPurchaser(url, m.mandateId, m.token, opts);
  if (before.job.state !== "complete" || before.job.report.passed)
    throw Error("Wrong spender was not delivered as a failed verification");
  await writeFile(
    workspace + "/proposal.json",
    JSON.stringify(correction.answer.proposal, null, 2),
  );
  const after = await runPurchaser(url, m.mandateId, m.token, opts);
  if (after.job.state !== "complete" || !after.job.report.passed)
    throw Error("Repaired proposal did not pass live preflight");
  const budget = (await exchange.view(m.mandateId, m.token)).budget;
  const evidence = {
    scope:
      "Local Exchange service, simulated fee settlement, real mainnet-state simulation. Replays a preserved correction from the paired Codex evaluation; no new builder model runs inside this demo.",
    summary: {
      beforePassed: before.job.report.passed,
      afterPassed: after.job.report.passed,
      spentTinybar: budget.spent,
      ceilingTinybar: "3000000",
    },
    before: { quote: before.quote, job: before.job },
    after: { quote: after.quote, job: after.job },
    correction: correction.answer,
  };
  await writeFile(root + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output: root, ...evidence.summary }));
  if (process.argv.includes("--capture")) {
    const { chromium } = await import("playwright");
    const { resolveMcpBrowser, playwrightLaunchOptionsForBrowser } =
      await import("../dist/mcpBrowser.js");
    const browser = await chromium.launch(
      playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(process.cwd())),
    );
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.locator(".session summary").click();
      await page.locator("#mid").fill(m.mandateId);
      await page.locator("#cap").fill(m.token);
      await page.locator("#connect").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#comparison")
          .textContent.includes("Latest: PASS"),
      );
      await page.locator("#results").scrollIntoViewIfNeeded();
      await page.screenshot({ path: root + "/results.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      )
        throw Error("Preflight evidence overflows mobile");
      if (errors.length) throw Error(errors.join(", "));
      await page.screenshot({ path: root + "/mobile.png", fullPage: true });
    } finally {
      await browser.close();
    }
  }
} finally {
  await exchange.idle();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await store.close();
}
