/** Combined-fault recovery checks; the original comparison suites remain separate. */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { SimulatedLedger } from "../lab/simulated.js";
const fixtures = {
  accounts: { organizer: { hbar: 100 }, customer: { hbar: 10 } },
  tokens: { ticket: { treasury: "organizer", supply: 1 } },
  topics: ["attendance"],
};
const must = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
export async function runTicketStress(workspace: string) {
  const { createTicketService } = await import(
    pathToFileURL(path.join(workspace, "ticket-service.mjs")).href
  );
  const results = [];
  for (const name of [
    "lost-transfer-and-stale-mirror",
    "lost-checkin-response",
    "concurrent-checkins",
    "decline-then-retry",
  ]) {
    const faults = {
      mirrorDelayMs: name === "lost-transfer-and-stale-mirror" ? 250 : 0,
      rejectActors: name === "decline-then-retry" ? ["customer"] : [],
    };
    const ledger = new SimulatedLedger(faults);
    await ledger.provision(fixtures);
    const submissions: Array<{ type: string }> = [];
    let lost = false;
    const reads: unknown[] = [];
    let ownershipConfirmed = false;
    const service = createTicketService(async (route: string, op: any) => {
      if (route === "/observe") {
        must(
          op.type === "nftOwner",
          "App used an unsupported bridge observation",
        );
        const query = structuredClone(op);
        reads.push(query);
        const observation = await ledger.observe(query);
        if (
          query.token === "ticket" &&
          query.serial === 1 &&
          query.account === "customer" &&
          observation.matches
        )
          ownershipConfirmed = true;
        return observation;
      }
      must(route === "/execute", "Unsupported bridge route");
      submissions.push(structuredClone(op));
      const tx = await ledger.execute(op);
      if (
        !lost &&
        tx.status === "SUCCESS" &&
        ((name === "lost-transfer-and-stale-mirror" &&
          op.type === "transferNft") ||
          (name === "lost-checkin-response" && op.type === "submitMessage"))
      ) {
        lost = true;
        throw Error("Response lost after consensus; outcome unknown");
      }
      return tx;
    });
    const call = async (action: string) => {
      try {
        return await service.handle(action);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    let error;
    try {
      if (name === "decline-then-retry") {
        must(!(await call("buy")).ok, "Declined purchase reported success");
        must(
          !(
            await ledger.observe({
              type: "nftOwner",
              token: "ticket",
              serial: 1,
              account: "customer",
            })
          ).matches,
          "Declined purchase changed ownership",
        );
        faults.rejectActors.length = 0;
        must(
          (await call("buy")).ok,
          "Retry after explicit decline did not succeed",
        );
      } else if (name === "lost-transfer-and-stale-mirror") {
        const initial = await call("buy");
        must(
          !initial.ok || ownershipConfirmed,
          "Unknown transfer outcome reported success without ownership evidence",
        );
        const retry = await call("buy");
        must(
          !retry.ok || ownershipConfirmed,
          "Stale ownership reported success without confirmation",
        );
        must(
          submissions.filter((o) => o.type === "transferNft").length === 1,
          "Unknown transfer was resubmitted before mirror caught up",
        );
        await new Promise((r) => setTimeout(r, 300));
        must(
          (await call("buy")).ok,
          "Could not recover once ownership was visible",
        );
        must(
          submissions.filter((o) => o.type === "transferNft").length === 1,
          "Recovery resubmitted an already committed transfer",
        );
      } else {
        must((await call("buy")).ok, "Purchase prerequisite failed");
        if (name === "lost-checkin-response") {
          must(
            !(await call("check-in")).ok,
            "Unknown check-in outcome reported success",
          );
          for (let i = 0; i < 3; i++)
            must(
              !(await call("check-in")).ok,
              "Without receipt reconciliation, ambiguous check-in must stay pending",
            );
        } else {
          const calls = await Promise.all(
            Array.from({ length: 8 }, () => call("check-in")),
          );
          must(
            calls.every((r) => r.ok),
            "Concurrent check-ins did not all succeed",
          );
        }
        must(
          submissions.filter((o) => o.type === "submitMessage").length === 1,
          "Check-in submitted duplicate HCS messages",
        );
        const observed = await ledger.observe({
          type: "topicMessage",
          topic: "attendance",
          message: "ticket:1:customer",
        });
        must(
          observed.matches &&
            (observed.evidence as { messages: unknown[] }).messages.length ===
              1,
          "Expected exactly one actual attendance record",
        );
      }
      must(
        (
          await ledger.observe({
            type: "nftOwner",
            token: "ticket",
            serial: 1,
            account: "customer",
          })
        ).matches,
        "Successful flow did not leave the customer owning the actual NFT",
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await ledger.cleanup();
    }
    results.push({
      name,
      passed: !error,
      ...(error ? { error } : {}),
      transferSubmissions: submissions.filter((o) => o.type === "transferNft")
        .length,
      messageSubmissions: submissions.filter((o) => o.type === "submitMessage")
        .length,
      ownershipReads: reads.length,
    });
  }
  return {
    mode: "simulated",
    scope:
      "Exploratory combined faults; unknown HCS outcome may remain pending, no durable receipt reconciliation claimed",
    passed: results.every((r) => r.passed),
    results,
  };
}
