/** Buyer walkthrough: real HTTP/browser execution and optional live read-only mainnet.
 * Payments in this local evaluation are explicitly simulated. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { loadConfig } from "../dist/verification/cli.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { chromium } from "playwright";
import {
  playwrightLaunchOptionsForBrowser,
  resolveMcpBrowser,
} from "../dist/mcpBrowser.js";
const output = path.resolve(".harness/runs/execution-contract-walkthrough");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "contract-walkthrough-"));
const config = await loadConfig(
  path.resolve("examples/verification/service-catalog.json"),
);
const store = new Store(root);
await store.start();
const exchange = new Exchange(
  store,
  config.packs,
  config.target,
  new SimulatedPayment(),
  new LabExecutor(config.packs, path.join(root, "jobs")),
);
const admin = "local-walkthrough-admin-" + crypto.randomUUID();
const server = createExchangeServer(exchange, admin);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch(
  playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(process.cwd())),
);
const evidence = { paymentMode: "simulated", cases: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#admin").fill(admin);
  await page.waitForSelector("#required-purchase");
  assert.equal(await page.locator("#pick-local-ledger").isDisabled(), true);
  assert.equal(await page.locator("#pick-testnet-ledger").isDisabled(), true);
  for (const p of config.packs) {
    if (
      p.id !== "purchase" &&
      (await page.locator("#required-" + p.id).isChecked())
    )
      await page.locator("#required-" + p.id).uncheck();
    if (
      p.id !== "purchase" &&
      (await page.locator("#pick-" + p.id).isChecked())
    )
      await page.locator("#pick-" + p.id).uncheck();
  }
  await page.locator("#rep-purchase").fill("1");
  await page.locator("#ceiling").fill("0.01");
  await page.locator("#create").click();
  await page.waitForFunction(
    () => document.querySelector("#mid").value.length > 5,
  );
  await page.locator("#quote").click();
  await page.getByRole("button", { name: "Accept & reserve" }).waitFor();
  assert.match(
    await page.locator("#timeline").textContent(),
    /Application network fees: 0/,
  );
  await page.screenshot({
    path: path.join(output, "01-quote.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Accept & reserve" }).click();
  await page
    .getByRole("button", { name: "Execute with simulated payment" })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#timeline")
        .textContent.includes("inspect evidence"),
    {},
    { timeout: 30000 },
  );
  assert.match(await page.locator("#timeline").textContent(), /PASS/);
  const view = await page.evaluate(() => structuredClone(view));
  evidence.cases.push({
    name: "Browser buyer: simulation quote, payment and delivery",
    passed: true,
    quotes: view.quotes,
    jobs: view.jobs,
  });
  await page.locator("#admin").fill("");
  await page.screenshot({
    path: path.join(output, "02-delivery.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "03-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  if (process.argv.includes("--mainnet")) {
    async function api(route, method = "GET", data, token = admin) {
      const r = await fetch(base + route, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const b = await r.json();
      if (!r.ok) throw Error(JSON.stringify(b));
      return b;
    }
    const m = await api("/mandates", "POST", {
      target: config.target,
      revision: "registered-approval-v1",
      required: ["approval-preflight"],
      ceiling: "1000000",
      executionEnvironments: ["mainnet-preflight"],
    });
    const q = await api(
      "/quotes",
      "POST",
      {
        mandateId: m.mandateId,
        selection: [{ pack: "approval-preflight", repetitions: 1 }],
      },
      m.token,
    );
    const j = await api("/quotes/" + q.id + "/accept", "POST", {}, m.token);
    const r = await fetch(base + "/jobs/" + j.id + "/pay", {
      method: "POST",
      headers: {
        authorization: "Bearer " + m.token,
        "payment-signature": Buffer.from(
          JSON.stringify({ simulation: true, quoteId: q.id }),
        ).toString("base64"),
      },
    });
    assert.equal(r.status, 202);
    await exchange.idle();
    const result = await api("/jobs/" + j.id, "GET", undefined, m.token);
    assert.equal(result.state, "complete");
    assert.equal(result.report.passed, true);
    evidence.cases.push({
      name: "Live read-only mainnet approval; simulated service payment",
      passed: true,
      quote: q,
      job: result,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(".session summary").click();
    await page.locator("#mid").fill(m.mandateId);
    await page.locator("#cap").fill(m.token);
    await page.locator("#connect").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#timeline")
        .textContent.includes("Mainnet-state simulation"),
    );
    await page.screenshot({
      path: path.join(output, "04-mainnet.png"),
      fullPage: true,
    });
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      cases: evidence.cases.map((c) => c.name),
      output,
    }),
  );
} finally {
  await browser.close();
  await exchange.idle();
  await new Promise((r) => server.close(r));
  await store.close();
}
