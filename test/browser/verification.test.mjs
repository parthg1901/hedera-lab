import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import {
  resolveMcpBrowser,
  playwrightLaunchOptionsForBrowser,
} from "../../dist/mcpBrowser.js";
import { Store } from "../../dist/verification/store.js";
import { Exchange } from "../../dist/verification/engine.js";
import { SimulatedPayment } from "../../dist/verification/payment.js";
import { LabExecutor } from "../../dist/verification/executor.js";
import { createExchangeServer } from "../../dist/verification/server.js";
import { loadConfig } from "../../dist/verification/cli.js";
for (const recommended of [false, true])
  test(
    "customer dashboard renders actual evidence; change recommendation=" +
      recommended,
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "verification-ui-"),
      );
      const c = await loadConfig(
        path.resolve(
          recommended
            ? "examples/verification/payment-catalog.json"
            : "examples/verification/catalog.json",
        ),
      );
      const store = new Store(directory);
      await store.start();
      const ex = new Exchange(
        store,
        c.packs,
        c.target,
        new SimulatedPayment(),
        new LabExecutor(c.packs, path.join(directory, "jobs")),
      );
      const admin = "browser-test-customer-admin-token";
      const server = createExchangeServer(ex, admin);
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const browser = await chromium.launch(
        playwrightLaunchOptionsForBrowser(
          await resolveMcpBrowser(process.cwd()),
        ),
      );
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1100 },
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("http://127.0.0.1:" + server.address().port);
        await page.locator("#admin").fill(admin);
        await page.locator("#ceiling").fill(recommended ? "0.024" : "0.04");
        if (recommended) {
          for (const p of c.packs)
            if (p.id !== "service-delivery")
              await page.locator("#required-" + p.id).uncheck();
          await page.locator("#changed-files").fill("payment.ts");
          await page
            .locator("#change-summary")
            .fill("Fix payment retries after a timeout");
        }
        await page.locator("#create").click();
        await page.waitForFunction(
          () => document.querySelector("#mid").value.length > 5,
        );
        await page.locator(recommended ? "#negotiate" : "#quote").click();
        if (recommended) {
          await page.waitForFunction(() =>
            document
              .querySelector("#decision")
              .textContent.includes("mandatory coverage"),
          );
          assert.equal(
            await page.locator("#pick-service-delivery").isDisabled(),
            true,
          );
          assert.equal(
            await page.locator("#rep-payment-timeout").inputValue(),
            "1",
          );
          assert.equal(
            await page.locator("#pick-budget-race").isChecked(),
            false,
          );
        }
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
          { timeout: 15000 },
        );
        assert.match(await page.locator("#timeline").textContent(), /PASS/);
        assert.equal(
          await page.locator("#spent").textContent(),
          recommended ? "0.0240 ℏ" : "0.0400 ℏ",
        );
        if (recommended)
          assert.match(
            await page.locator("#timeline").textContent(),
            /Declared change: Fix payment retries/,
          );
        assert.equal(await page.locator("#available").textContent(), "0.0000 ℏ");
        const evidence=page.locator('details[data-disclosure]').filter({has:page.locator('summary', {hasText:'inspect evidence'})});
        await evidence.locator('summary').click();
        await page.evaluate(() => refresh());
        assert.equal(await evidence.evaluate(e=>e.open),true);
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.setViewportSize({width:1440,height:1100});
        assert.equal(await page.locator("#error").textContent(), "");
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: path.join(directory, "dashboard.png"),
          fullPage: true,
        });
      } finally {
        await browser.close();
        await ex.idle();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

test("opening a live mandate restores its exact execution funding authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "funding-ui-"));
  const c = await loadConfig(path.resolve("examples/verification/service-catalog.json"));
  const store = new Store(directory);await store.start();
  const ex = new Exchange(store,c.packs,c.target,new SimulatedPayment(),{
    readiness: async()=>({available:true,reason:"Stubbed availability; no network execution"}),
    run: async()=>{throw Error("This UI test must not execute ledger transactions");},
  });
  const mandate=await ex.createMandate({target:c.target,revision:"restore-budget",required:["testnet-ledger"],ceiling:"2000000",executionEnvironments:["testnet"],executionCeilings:{testnet:"7012345678"}});
  const server=createExchangeServer(ex,"browser-funding-test-admin-token");await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const browser=await chromium.launch(playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(process.cwd())));
  try {
    const page=await browser.newPage();await page.goto("http://127.0.0.1:"+server.address().port);
    await page.locator('details.session summary').click();
    await page.locator('#mid').fill(mandate.mandateId);await page.locator('#cap').fill(mandate.token);await page.locator('#connect').click();
    await page.waitForFunction(()=>document.querySelector('#funding-testnet').value==='70.12345678');
    assert.equal(await page.locator('#env-testnet').isChecked(),true);
    assert.equal(await page.locator('#funding-testnet').isVisible(),true);
    assert.equal(await page.locator('#error').innerText(),'');
  } finally {await browser.close();await ex.idle();server.closeAllConnections();await new Promise(r=>server.close(r));await store.close();await rm(directory,{recursive:true,force:true});}
});
