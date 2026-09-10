import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { TransactionJournal } from "./transactions.js";
import { parseOperation } from "./schema.js";
import { LabInfrastructureError, type LabFixtures, type Ledger, type TxEvidence } from "./types.js";
/** Server-side test adapter. Never send its bearer token to browser code. */
export async function startBridge(ledger: Ledger, fixtures: LabFixtures, onTransaction: (tx: TxEvidence) => void, onInfrastructure: (error: LabInfrastructureError) => void, recoveryDirectory?: string) {
  const journal = recoveryDirectory ? new TransactionJournal(ledger, fixtures, recoveryDirectory, onTransaction) : undefined;
  await journal?.start();
  const token = randomBytes(32).toString("hex");
  // Serialize writes so concurrent UI requests cannot race simulator state.
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end('{"error":"Forbidden"}'); return;
    }
    if (req.method === "GET" && req.url === "/capabilities") { res.end(JSON.stringify({ durableReceipts: !!journal })); return; }
    if (req.method === "GET" && req.url === "/fixtures") { res.end(JSON.stringify(ledger.resources)); return; }
    if (req.method !== "POST" || !["/execute", "/observe", "/execute-once", "/receipt"].includes(req.url ?? "")) { res.writeHead(404).end('{}'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) { res.writeHead(413).end('{}'); req.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (["/execute-once", "/receipt"].includes(req.url!)) {
        if (!journal) { res.writeHead(409).end(JSON.stringify({ error: "Durable receipt recovery is not configured" })); return; }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request");
        const allowed = req.url === "/receipt" ? ["requestId"] : ["requestId", "operation", "retryFailed"];
        if (Object.keys(input).some(k => !allowed.includes(k)) || (input.retryFailed !== undefined && typeof input.retryFailed !== "boolean")) throw new Error("Invalid request");
        const result = queue.then(() => req.url === "/receipt"
          ? journal.receipt(input.requestId)
          : journal.execute(input.requestId, parseOperation(input.operation, fixtures), input.retryFailed === true));
        queue = result.catch(() => undefined);
        res.end(JSON.stringify(await result));
      } else if (req.url === "/execute") {
        const operation = parseOperation(input, fixtures);
        const result = queue.then(async () => { const tx = await ledger.execute(operation); onTransaction(tx); return tx; });
        queue = result.catch(() => undefined);
        res.end(JSON.stringify(await result));
      } else {
        // Only the public NFT ownership read needed by the example. The assertion
        // engine independently reads ledger state; app responses never prove a pass.
        if (!input || input.type !== "nftOwner" || !Object.hasOwn(fixtures.tokens, input.token) || !Object.hasOwn(fixtures.accounts, input.account) || !Number.isInteger(input.serial) || input.serial < 1) throw new Error("Invalid ownership read");
        res.end(JSON.stringify(await ledger.observe(input)));
      }
    } catch (error) {
      if (error instanceof LabInfrastructureError) { onInfrastructure(error); res.writeHead(503).end(JSON.stringify({ error: error.message })); }
      else res.writeHead(400).end('{"error":"Invalid Lab request"}');
    }
  });
  server.requestTimeout = 20_000;
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (e) { await journal?.close(); throw e; }
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    async stop() {
      closing = true;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await queue;
      await journal?.close();
    },
  };
}
