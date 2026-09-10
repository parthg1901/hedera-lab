import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../dist/verification/store.js";
import { Exchange } from "../dist/verification/engine.js";
import { SimulatedPayment } from "../dist/verification/payment.js";
import { LabExecutor } from "../dist/verification/executor.js";
import { RoutedExecutor } from "../dist/verification/remote-executor.js";
import {
  TestnetWorker,
  startWorkerServer,
  workerRequest,
} from "../dist/verification/worker.js";
import { loadConfig } from "../dist/verification/cli.js";
import { hash } from "../dist/verification/model.js";
import { operatorKeyMaterial } from "../dist/lab/live.js";
const config = await loadConfig(
  path.resolve("examples/verification/service-catalog.json"),
);
const packs = config.packs.filter((p) => p.id === "testnet-ledger");
async function fixture({ balance = 20000000000n, delay = 20 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-worker-"));
  const ws = new Store(path.join(root, "worker"));
  await ws.start();
  let executions = 0;
  const executor = {
    readiness: async () => ({ available: true, reason: "stubbed network" }),
    run: async (q, j) => {
      executions++;
      await new Promise((r) => setTimeout(r, delay));
      return {
        infrastructureFailure: false,
        report: {
          jobId: j.id,
          quoteId: q.id,
          contractHash: q.contractHash,
          passed: true,
          executed: 1,
          runs: [
            {
              pack: "testnet-ledger",
              iteration: 1,
              report: {
                mode: "testnet",
                passed: true,
                evidenceLabel: "stubbed worker test; no network writes",
              },
            },
          ],
          funding: [],
        },
      };
    },
  };
  const worker = new TestnetWorker(ws, packs, executor, async () => balance);
  await worker.start();
  const secret = "worker-test-secret-with-at-least-32-characters";
  const socket = path.join(root, "worker.sock");
  const server = await startWorkerServer(worker, socket, secret);
  const apiStore = new Store(path.join(root, "api"));
  await apiStore.start();
  const router = new RoutedExecutor(
    new LabExecutor(config.packs, path.join(root, "local")),
    socket,
    secret,
  );
  let settlements = 0;
  const payment = new SimulatedPayment();
  const original = payment.settle.bind(payment);
  payment.settle = async (...args) => {
    settlements++;
    return original(...args);
  };
  const ex = new Exchange(
    apiStore,
    config.packs,
    config.target,
    payment,
    router,
  );
  const m = await ex.createMandate({
    target: config.target,
    revision: "worker-test-v1",
    required: ["testnet-ledger"],
    ceiling: "10000000",
    executionEnvironments: ["testnet"],
    executionCeilings: { testnet: "14000000000" },
  });
  const quote = () =>
    ex.quote(m.mandateId, m.token, [
      { pack: "testnet-ledger", repetitions: 1 },
    ]);
  return {
    root,
    worker,
    ws,
    ex,
    router,
    apiStore,
    m,
    quote,
    secret,
    socket,
    server,
    executor,
    get executions() {
      return executions;
    },
    get settlements() {
      return settlements;
    },
    close: async () => {
      await ex.idle();
      await worker.idle();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await apiStore.close();
      await ws.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("private worker authenticates requests and binds registered artifacts and funding", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      workerRequest(f.socket, "bad", "/health"),
      /authorization/,
    );
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    const mutated = structuredClone(q);
    mutated.execution[0].terms.feeCeilingTinybar = "99999999999";
    const { contractHash, ...body } = mutated;
    mutated.contractHash = hash(body);
    await assert.rejects(f.worker.reserve(mutated, j), /artifacts or funding/);
    await assert.rejects(
      f.worker.reserve({ ...q, contractHash: "invalid" }, j),
      /binding/,
    );
    assert.equal(f.executions, 0);
    assert.equal(f.settlements, 0);
  } finally {
    await f.close();
  }
});
test("funded worker capacity is reserved before payment; racing buyer cannot oversubscribe", async () => {
  const f = await fixture({ balance: 8000000000n, delay: 800 });
  try {
    const qs = await Promise.all([f.quote(), f.quote()]);
    const js = await Promise.all(qs.map((q) => f.ex.accept(q.id, f.m.token)));
    const results = await Promise.allSettled(
      js.map((j, i) =>
        f.ex.pay(j.id, f.m.token, { simulation: true, quoteId: qs[i].id }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.settlements, 1);
    await f.ex.idle();
    assert.equal(f.executions, 1);
  } finally {
    await f.close();
  }
});
test("duplicate worker dispatch and result retries execute once and preserve evidence after restart", async () => {
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    await f.ex.pay(j.id, f.m.token, { simulation: true, quoteId: q.id });
    await f.ex.idle();
    const before = await f.worker.get(j.id);
    assert.equal(before.state, "complete");
    await Promise.all(
      Array.from({ length: 8 }, () =>
        workerRequest(f.socket, f.secret, "/jobs/" + j.id + "/run", "POST"),
      ),
    );
    await f.worker.idle();
    assert.equal(f.executions, 1);
    await f.ws.close();
    await f.ws.start();
    const resumed = new TestnetWorker(
      f.ws,
      packs,
      f.executor,
      async () => 20000000000n,
    );
    await resumed.start();
    assert.deepEqual(await resumed.get(j.id), before);
  } finally {
    await f.close();
  }
});
test("worker restart never replays a persisted running job or releases its uncertain exposure", async () => {
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    await f.worker.reserve(q, j);
    await f.ws.mutate((s) => {
      s.workerJobs[j.id].state = "running";
    });
    await f.ws.close();
    await f.ws.start();
    const resumed = new TestnetWorker(
      f.ws,
      packs,
      f.executor,
      async () => 7000000000n,
    );
    await resumed.start();
    assert.equal((await resumed.get(j.id)).state, "interrupted");
    assert.equal((await resumed.readiness("testnet-ledger")).available, false);
    await resumed.run(j.id);
    await resumed.idle();
    assert.equal(f.executions, 0);
    await assert.rejects(resumed.release(j.id), /already started/);
  } finally {
    await f.close();
  }
});
test("API restart resumes existing remote-only job without re-executing worker transactions", async () => {
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    await f.ex.pay(j.id, f.m.token, { simulation: true, quoteId: q.id });
    await f.ex.idle();
    await f.apiStore.mutate((s) => {
      s.jobs[j.id].state = "running";
      delete s.jobs[j.id].report;
      delete s.jobs[j.id].reportHash;
    });
    await f.ex.recoverStartup();
    await f.ex.idle();
    assert.equal((await f.ex.job(j.id, f.m.token)).state, "complete");
    assert.equal(f.executions, 1);
    assert.equal(f.settlements, 1);
  } finally {
    await f.close();
  }
});
test("unavailable worker fails before payment and file-based key is not exported in environment", async () => {
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    await new Promise((r) => f.server.close(r));
    await assert.rejects(
      f.ex.pay(j.id, f.m.token, { simulation: true, quoteId: q.id }),
      /offline or unreachable/,
    );
    assert.equal(f.settlements, 0);
    const file = path.join(f.root, "key");
    await writeFile(file, "temporary-test-value\n", { mode: 0o600 });
    process.env.WORKER_TEST_KEY_FILE = file;
    try {
      assert.equal(
        await operatorKeyMaterial({
          mode: "testnet",
          operatorKeyEnv: "WORKER_TEST_KEY",
        }),
        "temporary-test-value",
      );
      assert.equal(process.env.WORKER_TEST_KEY, undefined);
    } finally {
      delete process.env.WORKER_TEST_KEY_FILE;
    }
  } finally {
    await f.close();
  }
});

test("unsubmitted cancellation and definite payment rejection release worker funds", async () => {
  const { RejectedPayment } = await import("../dist/verification/engine.js");
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    await f.worker.reserve(q, j);
    await f.ex.cancel(j.id, f.m.token);
    assert.equal((await f.worker.get(j.id)).state, "cancelled");
    const q2 = await f.quote();
    const j2 = await f.ex.accept(q2.id, f.m.token);
    f.ex.payment.settle = async () => {
      throw new RejectedPayment("definite test rejection");
    };
    await assert.rejects(
      f.ex.pay(j2.id, f.m.token, { simulation: true, quoteId: q2.id }),
      /Payment rejected/,
    );
    assert.equal((await f.worker.get(j2.id)).state, "cancelled");
    assert.equal(f.executions, 0);
  } finally {
    await f.close();
  }
});

test("ambiguous payment retains worker funds and never starts execution", async () => {
  const f = await fixture();
  try {
    const q = await f.quote();
    const j = await f.ex.accept(q.id, f.m.token);
    f.ex.payment.settle = async () => {
      throw Error("lost settlement response");
    };
    await assert.rejects(
      f.ex.pay(j.id, f.m.token, { simulation: true, quoteId: q.id }),
      /unknown/,
    );
    assert.equal((await f.worker.get(j.id)).state, "reserved");
    assert.equal(f.executions, 0);
    assert.equal((await f.ex.job(j.id, f.m.token)).state, "payment_unknown");
  } finally {
    await f.close();
  }
});

test(
  "worker CLI stays alive after listening and releases ownership on SIGTERM",
  { timeout: 20000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { PrivateKey } = await import("@hiero-ledger/sdk");
    const root = await mkdtemp(path.join(os.tmpdir(), "worker-cli-"));
    const secret = "cli-lifecycle-test-token-at-least-32-characters";
    await writeFile(path.join(root, "token"), secret, { mode: 0o600 });
    await writeFile(
      path.join(root, "key"),
      PrivateKey.generateECDSA().toStringRaw(),
      { mode: 0o600 },
    );
    const socket = path.join(root, "worker.sock");
    const child = spawn(
      process.execPath,
      [
        "dist/index.js",
        "verify",
        "worker",
        "--store",
        path.join(root, "store"),
        "--socket",
        socket,
      ],
      {
        env: {
          ...process.env,
          HEDERA_OPERATOR_KEY: "",
          HEDERA_OPERATOR_ID: "0.0.1234",
          HEDERA_OPERATOR_KEY_FILE: path.join(root, "key"),
          VERIFIER_WORKER_TOKEN_FILE: path.join(root, "token"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    try {
      for (let i = 0; i < 100 && !output.includes("listening"); i++) {
        assert.equal(child.exitCode, null, output);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(output, /listening/);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(child.exitCode, null, "CLI must keep the server alive");
      assert.equal((await workerRequest(socket, secret, "/health")).ok, true);
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      const reopened = new Store(path.join(root, "store"));
      await reopened.start();
      await reopened.close();
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
