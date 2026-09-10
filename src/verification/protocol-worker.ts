/** Trusted test driver launched in a subprocess with no wallet credentials. Not a hardened sandbox. */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { runTicketStress } from "./ticketStress.js";
import { SimulatedLedger } from "../lab/simulated.js";
import type { Operation } from "../lab/types.js";
const fixtures = {
  accounts: { organizer: { hbar: 100 }, customer: { hbar: 10 } },
  tokens: { ticket: { treasury: "organizer", supply: 1 } },
  topics: ["attendance"],
};
const suite = process.argv[2],
  workspace = process.argv[3];
const events: Array<{
  id: string;
  kind: string;
  status: string;
  message: string;
  evidence?: unknown;
}> = [];
async function check(id: string, fn: () => Promise<unknown>) {
  try {
    events.push({
      id,
      kind: "assertion",
      status: "passed",
      message: "verified",
      evidence: await fn(),
    });
  } catch (e) {
    events.push({
      id,
      kind: "assertion",
      status: "failed",
      message: e instanceof Error ? e.message : "Unexpected application error",
    });
  }
}
function must(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function scenario(
  test: (
    service: any,
    ops: Operation[],
    ledger: SimulatedLedger,
  ) => Promise<unknown>,
  uncertain = false,
) {
  const ledger = new SimulatedLedger({ mirrorDelayMs: 0, rejectActors: [] });
  await ledger.provision(fixtures);
  const ops: Operation[] = [];
  let drop = uncertain;
  try {
    const { createTicketService } = await import(
      pathToFileURL(path.join(workspace, "ticket-service.mjs")).href
    );
    const service = createTicketService(
      async (route: string, operation: any) => {
        if (route === "/observe") return ledger.observe(operation);
        if (route !== "/execute") throw new Error("Unsupported adapter route");
        ops.push(structuredClone(operation));
        await sleep(15);
        const result = await ledger.execute(operation);
        if (
          drop &&
          operation.type === "transferNft" &&
          result.status === "SUCCESS"
        ) {
          drop = false;
          throw new Error(
            "Transaction outcome unavailable; do not blindly resubmit",
          );
        }
        return result;
      },
    );
    return await test(service, ops, ledger);
  } finally {
    await ledger.cleanup();
    ledger.close();
  }
}
const count = (ops: Operation[], type: string) =>
  ops.filter((o) => o.type === type).length;
if (suite === "purchase-replay")
  await check("one-transfer-for-repeated-purchase", () =>
    scenario(async (s, ops, l) => {
      const a = await s.handle("buy"),
        b = await s.handle("buy");
      must(
        a.ok && b.ok,
        "Repeated purchase must return success for the original purchase",
      );
      must(
        count(ops, "transferNft") === 1,
        "Repeated purchase submitted more than one NFT transfer",
      );
      must(
        (
          await l.observe({
            type: "nftOwner",
            token: "ticket",
            serial: 1,
            account: "customer",
          })
        ).matches,
        "Customer does not own the ticket",
      );
      return { transferSubmissions: count(ops, "transferNft") };
    }),
  );
else if (suite === "checkin-replay")
  await check("one-message-for-repeated-checkin", () =>
    scenario(async (s, ops) => {
      must((await s.handle("buy")).ok, "Purchase failed");
      const a = await s.handle("check-in"),
        b = await s.handle("check-in");
      must(a.ok && b.ok, "Repeated check-in did not succeed");
      must(
        count(ops, "submitMessage") === 1,
        "Repeated check-in submitted duplicate attendance messages",
      );
      return { messageSubmissions: count(ops, "submitMessage") };
    }),
  );
else if (suite === "concurrent-purchase")
  await check("concurrent-purchases-share-one-transfer", () =>
    scenario(async (s, ops, l) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => s.handle("buy")),
      );
      must(
        results.every((r) => r.ok),
        "Some concurrent callers did not receive the purchase result",
      );
      must(
        count(ops, "transferNft") === 1,
        "Concurrent calls submitted duplicate NFT transfers",
      );
      must(
        (
          await l.observe({
            type: "nftOwner",
            token: "ticket",
            serial: 1,
            account: "customer",
          })
        ).matches,
        "Ownership assertion failed",
      );
      return { callers: 8, transferSubmissions: count(ops, "transferNft") };
    }),
  );
else if (suite === "timeout-recovery")
  await check("recover-confirmed-transfer-without-resubmitting", () =>
    scenario(async (s, ops, l) => {
      try {
        await s.handle("buy");
      } catch {
        /* A first-call infrastructure error is permitted. */
      }
      const result = await s.handle("buy");
      must(
        result.ok,
        "Retry did not recover a confirmed purchase after a lost response",
      );
      must(
        count(ops, "transferNft") === 1,
        "A transfer with an unknown result was blindly resubmitted",
      );
      must(
        (
          await l.observe({
            type: "nftOwner",
            token: "ticket",
            serial: 1,
            account: "customer",
          })
        ).matches,
        "Ownership assertion failed",
      );
      return {
        transferSubmissions: count(ops, "transferNft"),
        fault: "response lost after successful transfer",
      };
    }, true),
  );
else if (suite === "fault-combinations") {
  const stress = await runTicketStress(workspace!);
  for (const result of stress.results)
    events.push({
      id: result.name,
      kind: "assertion",
      status: result.passed ? "passed" : "failed",
      message: result.error ?? "Combined fault verified",
      evidence: result,
    });
} else throw new Error("Unknown protected protocol suite");
console.log(
  JSON.stringify({
    schemaVersion: 1,
    mode: "simulated",
    browserExecuted: false,
    infrastructureFailure: false,
    passed: events.every((e) => e.status === "passed"),
    events,
  }),
);
