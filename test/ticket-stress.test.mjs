import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runStress } from "../scripts/ticket-stress.mjs";
const report = await runStress(path.resolve("examples/lab-ticketing"));
for (const result of report.results)
  test("ticket stress: " + result.name, () =>
    assert.equal(result.passed, true, JSON.stringify(result)),
  );
test("frozen pre-fix service reproduces duplicate HCS submission after lost response", async () => {
  const original = await runStress(
    path.resolve("test/fixtures/harness-comparison"),
  );
  const failure = original.results.find(
    (r) => r.name === "lost-checkin-response",
  );
  assert.equal(failure.passed, false);
  assert.equal(failure.messageSubmissions, 2);
});

test("stress oracle permits recovery by polling inside the original request", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp("/tmp/ticket-stress-poll-");
  try {
    const source = pathToFileURL(
      path.resolve("examples/lab-ticketing/ticket-service.mjs"),
    ).href;
    await writeFile(
      dir + "/ticket-service.mjs",
      `import {createTicketService as base} from ${JSON.stringify(source)};
export function createTicketService(ledger) {
 const service=base(ledger);
 return {async handle(action) {
  try { return await service.handle(action); }
  catch(error) {
   if(action!=='buy') throw error;
   await new Promise(resolve=>setTimeout(resolve,400));
   return service.handle(action);
  }
 }};
}`,
    );
    const report = await runStress(dir);
    assert.equal(report.passed, true, JSON.stringify(report));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
