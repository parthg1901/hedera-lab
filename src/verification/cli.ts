import { RoutedExecutor } from "./remote-executor.js";
import { runWorker } from "./worker-cli.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HcsAuditor } from "./audit.js";
import { Store } from "./store.js";
import { Exchange } from "./engine.js";
import { LabExecutor } from "./executor.js";
import { BlockyPayment, SimulatedPayment } from "./payment.js";
import { createExchangeServer } from "./server.js";
import { runPurchaser } from "./agent.js";
import type { Pack } from "./model.js";
export async function loadConfig(file: string) {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!config.target || !Array.isArray(config.packs) || !config.packs.length)
    throw new Error("Config requires a target and packs");
  const packs: Pack[] = config.packs.map((p: Pack) => ({
    ...p,
    scenario: path.resolve(path.dirname(file), p.scenario),
    workspace: path.resolve(path.dirname(file), p.workspace),
  }));
  return { target: config.target as string, packs };
}
export async function runVerificationCli(args: string[]) {
  const [command, ...rest] = args;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || !rest[i + 1])
      throw new Error("Options require --name value");
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  if (command === "agent") {
    if (!opts.url || !opts.mandate || !process.env.VERIFIER_CAPABILITY)
      throw new Error(
        "Use verify agent --url <url> --mandate <id>; set VERIFIER_CAPABILITY",
      );
    const result = await runPurchaser(
      opts.url,
      opts.mandate,
      process.env.VERIFIER_CAPABILITY,
      {
        pay: opts.pay === "yes",
        changes: opts.changes
          ? JSON.parse(await readFile(opts.changes, "utf8"))
          : undefined,
        allocation: opts.allocation,
        planner: opts.planner === "codex" ? "codex" : "policy",
        accountId: process.env.HEDERA_OPERATOR_ID,
        privateKey: process.env.HEDERA_OPERATOR_KEY,
        onEvent: (e) => console.log(JSON.stringify(e)),
      },
    );
    if (result.job && result.job.state !== "complete") process.exitCode = 1;
    return;
  }
  if (command === "worker") {
    const config = await loadConfig(
      path.resolve(opts.config ?? "examples/verification/service-catalog.json"),
    );
    await runWorker(
      config.packs,
      path.resolve(opts.store ?? "/data"),
      opts.socket ?? "/worker-socket/worker.sock",
    );
    return;
  }
  if (command !== "serve" && command !== "demo")
    throw new Error(
      "Usage: hedera-harness verify <serve|demo> --config <json> [--port 4318] [--store path] [--mode simulated|testnet], or verify agent --url <url> --mandate <id> --pay yes",
    );
  const config = await loadConfig(
    path.resolve(opts.config ?? "examples/verification/catalog.json"),
  );
  const directory = path.resolve(
    opts.store ?? `.harness/runs/verifier-${command}`,
  );
  const mode = opts.mode ?? "simulated";
  if (!["simulated", "testnet"].includes(mode))
    throw new Error("Mode must be simulated or testnet");
  if (command === "demo" && mode !== "simulated")
    throw new Error(
      "Demo is explicitly simulated; use serve + agent for authorized testnet payments",
    );
  const payment =
    mode === "simulated"
      ? new SimulatedPayment()
      : new BlockyPayment(process.env.VERIFIER_PAY_TO ?? "");
  const store = new Store(directory);
  await store.start();
  const localExecutor = new LabExecutor(
    config.packs,
    path.join(directory, "jobs"),
  );
  const workerSocket = process.env.VERIFIER_WORKER_SOCKET;
  const workerToken = workerSocket
    ? (await readFile(process.env.VERIFIER_WORKER_TOKEN_FILE!, "utf8")).trim()
    : undefined;
  const exchange = new Exchange(
    store,
    config.packs,
    config.target,
    payment,
    workerSocket
      ? new RoutedExecutor(localExecutor, workerSocket, workerToken!)
      : localExecutor,
    process.env.VERIFIER_HCS_TOPIC_ID
      ? new HcsAuditor(process.env.VERIFIER_HCS_TOPIC_ID)
      : undefined,
  );
  const admin =
    process.env.VERIFIER_ADMIN_TOKEN ??
    (process.env.VERIFIER_ADMIN_TOKEN_FILE
      ? (await readFile(process.env.VERIFIER_ADMIN_TOKEN_FILE, "utf8")).trim()
      : randomBytes(32).toString("hex"));
  const server = createExchangeServer(exchange, admin);
  const port = Number(opts.port ?? (command === "demo" ? 0 : 4318));
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  await exchange.recoverStartup();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, opts.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  const close = async () => {
    server.close();
    server.closeIdleConnections();
    await exchange.idle();
    server.closeAllConnections();
    await store.close();
  };
  if (command === "demo") {
    try {
      const min = config.packs.reduce((n, p) => n + BigInt(p.priceTinybar), 0n);
      const mandate = await exchange.createMandate({
        target: config.target,
        revision: "demo-v1",
        required: config.packs.map((p) => p.id),
        ceiling: (min * 2n).toString(),
      });
      const events: unknown[] = [];
      const result = await runPurchaser(url, mandate.mandateId, mandate.token, {
        pay: true,
        planner: opts.planner === "codex" ? "codex" : "policy",
        onEvent: (e) => {
          events.push(e);
          console.log(JSON.stringify(e));
        },
      });
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "demo-evidence.json"),
        JSON.stringify({ mode: "simulated", events, result }, null, 2),
      );
      if (
        result.job?.state !== "complete" ||
        (result.job.report as any)?.passed !== true
      )
        process.exitCode = 1;
    } finally {
      await close();
    }
    return;
  }
  console.log(`Verifier Exchange: ${url} [${mode}]`);
  if (
    !process.env.VERIFIER_ADMIN_TOKEN &&
    !process.env.VERIFIER_ADMIN_TOKEN_FILE
  ) {
    const file = path.join(directory, "customer-token");
    await writeFile(file, admin, { mode: 0o600 });
    console.log(
      `Customer authorization token stored in ${file} (private; not printed)`,
    );
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
