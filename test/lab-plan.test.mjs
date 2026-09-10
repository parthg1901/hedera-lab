import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  readFile,
  cp,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseScenario, loadScenario } from "../dist/lab/schema.js";
import { prepareApplicationOperations } from "../dist/lab/plan.js";
import { runScenario } from "../dist/lab/runner.js";
import { LabExecutor } from "../dist/verification/executor.js";
const base = () => ({
  schemaVersion: 1,
  name: "plan",
  network: { mode: "simulated" },
  fixtures: {
    accounts: { alice: { hbar: 5 }, bob: { hbar: 1 } },
    tokens: {},
    topics: [],
  },
  steps: [
    { id: "pay", planOperation: { file: "plan.json", index: 0 } },
    {
      id: "amount",
      assert: { type: "hbarBalance", account: "bob", min: 2, max: 2 },
    },
  ],
});
const plan = () => ({
  schemaVersion: 1,
  operations: [{ type: "transferHbar", actor: "alice", to: "bob", amount: 1 }],
});
async function temp(fn) {
  const d = await mkdtemp(path.join(os.tmpdir(), "lab-plan-"));
  try {
    await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}
test("plan schema rejects paths, unknown fields, mixed actions and invalid indices", () => {
  for (const ref of [
    { file: "../plan.json", index: 0 },
    { file: "/plan.json", index: 0 },
    { file: "plan.js", index: 0 },
    { file: "plan.json", index: -1 },
    { file: "plan.json", index: 20 },
    { file: "plan.json", index: 0, command: "anything" },
  ]) {
    const s = base();
    s.steps[0].planOperation = ref;
    assert.throws(() => parseScenario(s));
  }
  const s = base();
  s.steps[0].operation = plan().operations[0];
  assert.throws(() => parseScenario(s));
});
test("inert plan resolves supported operations and binds exact bytes", () =>
  temp(async (d) => {
    await writeFile(d + "/plan.json", JSON.stringify(plan()));
    const r = await prepareApplicationOperations(parseScenario(base()), d);
    assert.deepEqual(r.scenario.steps[0].operation, plan().operations[0]);
    assert.match(r.artifacts["plan.json"], /^[a-f0-9]{64}$/);
    await writeFile(d + "/plan.json", JSON.stringify(plan(), null, 2));
    assert.notEqual(
      (await prepareApplicationOperations(parseScenario(base()), d)).artifacts[
        "plan.json"
      ],
      r.artifacts["plan.json"],
    );
  }));
test("rejects external entities, executable fields, oversized data and partial plans", () =>
  temp(async (d) => {
    for (const value of [
      { ...plan(), command: "node malicious.js" },
      {
        schemaVersion: 1,
        operations: [{ ...plan().operations[0], to: "0.0.1234" }],
      },
      { schemaVersion: 1, operations: [{ type: "execute", actor: "alice" }] },
      {
        schemaVersion: 1,
        operations: [...plan().operations, ...plan().operations],
      },
    ]) {
      await writeFile(d + "/plan.json", JSON.stringify(value));
      await assert.rejects(
        prepareApplicationOperations(parseScenario(base()), d),
      );
    }
    await writeFile(d + "/plan.json", " ".repeat(65537));
    await assert.rejects(
      prepareApplicationOperations(parseScenario(base()), d),
      /64 KiB/,
    );
    await writeFile(d + "/plan.json", JSON.stringify(plan()));
    const s = base();
    s.steps.splice(1, 0, {
      id: "duplicate",
      planOperation: { file: "plan.json", index: 0 },
    });
    await assert.rejects(
      prepareApplicationOperations(parseScenario(s), d),
      /more than once/,
    );
  }));
test("rejects symlink plans and invalid plans before provisioning or payment readiness", () =>
  temp(async (d) => {
    await writeFile(d + "/outside.json", JSON.stringify(plan()));
    await symlink(d + "/outside.json", d + "/plan.json");
    await assert.rejects(
      prepareApplicationOperations(parseScenario(base()), d),
      /symlink/,
    );
    await rm(d + "/plan.json");
    await writeFile(d + "/scenario.json", JSON.stringify(base()));
    const r = await runScenario({
      file: d + "/scenario.json",
      workspace: d,
      outputDirectory: d + "/out",
    });
    assert.equal(r.passed, false);
    assert.deepEqual(r.resources.accounts, {});
    const p = {
      id: "plan",
      scenario: d + "/scenario.json",
      workspace: d,
      priceTinybar: "1",
    };
    assert.equal(
      (await new LabExecutor([p], d + "/jobs").readiness(p)).available,
      false,
    );
  }));
test("a correct application plan passes independent balances and records its fingerprint", () =>
  temp(async (d) => {
    await writeFile(d + "/plan.json", JSON.stringify(plan()));
    await writeFile(d + "/scenario.json", JSON.stringify(base()));
    const r = await runScenario({
      file: d + "/scenario.json",
      workspace: d,
      outputDirectory: d + "/out",
    });
    assert.equal(r.passed, true);
    assert.match(r.applicationArtifacts["plan.json"], /^[a-f0-9]{64}$/);
    assert.equal(
      r.events.find((e) => e.id === "pay").evidence.operation.to,
      "bob",
    );
  }));
