/** Disposable live-test worker: kill the actual bridge process after HCS consensus. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LiveLedger } from "../dist/lab/live.js";
import { startBridge } from "../dist/lab/bridge.js";
import { createTicketService } from "../examples/lab-ticketing/ticket-service.mjs";
const output = process.argv[2];
const { fixtures, config } = JSON.parse(
  await readFile(path.join(output, "crash-context.json"), "utf8"),
);
if (process.platform !== "linux" || !["local", "testnet"].includes(config?.mode))
  throw Error("Crash worker requires Linux and an explicit live network");
const ledger = new LiveLedger(config, path.join(output, "ledger"));
await ledger.resume(fixtures);
const execute = ledger.execute.bind(ledger);
ledger.execute = async (operation, before) => {
  const tx = await execute(operation, before);
  if (operation.type === "submitMessage" && tx.status === "SUCCESS") {
    await new Promise(() =>
      process.send({ transactionId: tx.transactionId }, () =>
        process.kill(process.pid, "SIGKILL"),
      ),
    );
  }
  return tx;
};
const bridge = await startBridge(
  ledger,
  fixtures,
  () => {},
  () => {},
  path.join(output, "transactions"),
);
const api = async (route, input) => {
  const r = await fetch(bridge.url + route, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Error("Bridge HTTP " + r.status);
  return r.json();
};
try {
  const app = createTicketService(api, { recoverable: true });
  if (!(await app.handle("buy")).ok) throw Error("Purchase failed");
  await app.handle("check-in");
  throw Error("Expected process kill did not happen");
} finally {
  await bridge.stop();
  ledger.close();
}
