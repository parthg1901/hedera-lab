import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { LabExecutor } from "./executor.js";
import { executionTerms } from "./contracts.js";
import { operatorKeyMaterial } from "../lab/live.js";
import { importHieroSdk } from "../optionalDeps.js";
import { TestnetWorker, startWorkerServer } from "./worker.js";
import type { Pack } from "./model.js";
export async function runWorker(
  packs: Pack[],
  directory: string,
  socket: string,
) {
  const secretFile = process.env.VERIFIER_WORKER_TOKEN_FILE;
  if (
    !secretFile ||
    !process.env.HEDERA_OPERATOR_ID ||
    !process.env.HEDERA_OPERATOR_KEY_FILE
  )
    throw Error(
      "Worker requires token file, dedicated operator ID and signing-key file",
    );
  const secret = (await readFile(secretFile, "utf8")).trim();
  const registered: Pack[] = [];
  for (const pack of packs)
    if ((await executionTerms(pack)).environment === "testnet")
      registered.push(pack);
  if (!registered.length) throw Error("No testnet packages registered");
  const sdk = await importHieroSdk();
  const client = sdk.Client.forTestnet();
  client.setOperator(
    process.env.HEDERA_OPERATOR_ID,
    sdk.PrivateKey.fromStringECDSA(
      (await operatorKeyMaterial({ mode: "testnet" })).replace(/^0x/i, ""),
    ),
  );
  client.setRequestTimeout(15000);
  client.setMaxAttempts(2);
  const balance = async () =>
    BigInt(
      (
        await new sdk.AccountBalanceQuery()
          .setAccountId(process.env.HEDERA_OPERATOR_ID!)
          .execute(client)
      ).hbars
        .toTinybars()
        .toString(),
    );
  const store = new Store(directory);
  await store.start();
  const executor = new LabExecutor(registered, path.join(directory, "jobs"));
  const worker = new TestnetWorker(
    store,
    registered,
    {
      readiness: (p, probe) => executor.readiness(p, probe),
      run: (q, j) =>
        executor.run(
          q,
          j,
          q.selection.filter((s) => registered.some((p) => p.id === s.pack)),
        ),
    },
    balance,
  );
  try {
    await worker.start();
    await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
    const server = await startWorkerServer(worker, socket, secret);
    console.log("Testnet worker listening on private Unix socket");
    const close = async () => {
      server.close();
      server.closeIdleConnections();
      await worker.idle();
      server.closeAllConnections();
      await store.close();
      client.close();
    };
    // The CLI exits when this function resolves; keep ownership until shutdown.
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        close().then(resolve, reject);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  } catch (e) {
    await store.close();
    client.close();
    throw e;
  }
}
