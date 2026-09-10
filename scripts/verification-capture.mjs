import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  resolveMcpBrowser,
  playwrightLaunchOptionsForBrowser,
} from "../dist/mcpBrowser.js";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { createExchangeServer } from "../dist/verification/server.js";
import { loadConfig } from "../dist/verification/cli.js";
const dir = path.resolve(
  process.argv[2] ?? ".harness/runs/verification-dashboard",
);
await mkdir(dir, { recursive: true });
const c = await loadConfig(path.resolve("examples/verification/payment-catalog.json"));
const store = new Store(dir + "/service");
await store.start();
const ex = new Exchange(
  store,
  c.packs,
  c.target,
  new SimulatedPayment(),
  new LabExecutor(c.packs, dir + "/jobs"),
);
const admin = "local-capture-customer-authorization";
const server = createExchangeServer(ex, admin);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch(
  playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(process.cwd())),
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  recordVideo: { dir: dir + "/video", size: { width: 1440, height: 1200 } },
});
try {
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#admin").fill(admin);
  await page.locator("#ceiling").fill("0.024");
  for(const p of c.packs)if(p.id!=="service-delivery")await page.locator("#required-"+p.id).uncheck();
  await page.locator("#changed-files").fill("src/payment.ts");
  await page.locator("#change-summary").fill("Fix payment retries after a settlement timeout");
  await page.locator("#create").click();
  await page.waitForFunction(
    () => document.querySelector("#mid").value.length > 5,
  );
  for (const p of c.packs) await page.locator("#rep-" + p.id).fill("3");
  await page.locator("#quote").click();
  await page.waitForFunction(() =>
    document.querySelector("#timeline").textContent.includes("Round 1"),
  );
  await page.locator("#negotiate").click();
  await page.waitForFunction(() =>
    document.querySelector("#timeline").textContent.includes("Round 2"),
  );
  await page.getByRole("button", { name: "Accept & reserve" }).last().click();
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
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({ path: dir + "/dashboard.png", fullPage: true });
  await page.screenshot({ path: dir + "/desktop.png" });
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile layout overflows');
  await page.screenshot({ path: dir + "/mobile.png",fullPage:true });
  await writeFile(
    dir + "/capture.json",
    JSON.stringify(
      {
        mode: "simulated",
        screenshot: "dashboard.png",
        video: await page.video().path(),
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  await ex.idle();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await store.close();
}
console.log(dir + "/dashboard.png");
