import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodeApproval,
  encodeApproval,
  validatePolicy,
} from "../dist/preflight/model.js";
import { verifyApproval } from "../dist/preflight/verify.js";
const fixture = JSON.parse(
  await readFile(
    new URL("../examples/preflight/evaluation.json", import.meta.url),
    "utf8",
  ),
);
const policy = fixture.policy;
const p = fixture.cases[0].proposal;
const snapshot = {
  network: "hedera-mainnet",
  block: "100",
  blockHash: "test-hash",
  timestamp: {},
};
const observation = (proposal = p, estimate = false) => ({
  request: {
    ...proposal,
    network: undefined,
    block: snapshot.block,
    value: Number(proposal.value),
    estimate,
  },
  httpStatus: 200,
  body: { result: estimate ? "0x186a0" : "0x" + "0".repeat(63) + "1" },
  durationMs: 1,
  observedAt: "2026-09-06T00:00:00Z",
});
for (const c of fixture.cases)
  test("approval policy: " + c.id, () => {
    const r = verifyApproval(
      policy,
      c.proposal,
      snapshot,
      observation(c.proposal),
      observation(c.proposal, true),
    );
    assert.equal(r.decision, c.expected);
    assert.equal(r.reportHash.length, 64);
  });
test("strict ABI rejects nonzero address padding, unknown methods, and extra bytes", () => {
  assert.equal(decodeApproval(p.data).allowance, policy.minAllowance);
  for (const data of [
    p.data + "00",
    p.data.replace("095ea7b3", "a9059cbb"),
    p.data.slice(0, 10) + "1" + p.data.slice(11),
  ])
    assert.throws(() => decodeApproval(data));
  assert.throws(() => encodeApproval(policy.spender, (1n << 256n).toString()));
  assert.throws(() =>
    validatePolicy({ ...policy, minAllowance: "200", maxAllowance: "100" }),
  );
});
test("unavailable mirror or gas estimate is inconclusive, never a pass", () => {
  for (const status of [429, 500, 503]) {
    const sim = {
      ...observation(),
      httpStatus: status,
      body: { error: "busy" },
    };
    assert.equal(
      verifyApproval(policy, p, snapshot, sim).decision,
      "inconclusive",
    );
  }
  assert.equal(
    verifyApproval(policy, p, snapshot, observation(), {
      ...observation(p, true),
      httpStatus: 429,
    }).decision,
    "inconclusive",
  );
});
test("report cannot reuse observations for a different block, transaction or estimate mode", () => {
  for (const change of [
    { block: "99" },
    { from: policy.spender },
    { data: "0x" },
    { value: 1 },
    { gas: 50000 },
    { estimate: true },
  ]) {
    const sim = observation();
    sim.request = { ...sim.request, ...change };
    const r = verifyApproval(policy, p, snapshot, sim);
    assert.equal(r.decision, "reject");
    assert.equal(
      r.checks.find((c) => c.id === "simulation-binding").status,
      "failed",
    );
  }
});
test("a contract revert and false return fail independently of policy checks", () => {
  for (const simulation of [
    {
      ...observation(),
      httpStatus: 400,
      body: {
        _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED" }] },
      },
    },
    { ...observation(), body: { result: "0x" + "0".repeat(64) } },
  ])
    assert.equal(
      verifyApproval(policy, p, snapshot, simulation).decision,
      "reject",
    );
});
test("gas estimate exceeding the transaction limit fails", () => {
  assert.equal(
    verifyApproval(policy, p, snapshot, observation(), {
      ...observation(p, true),
      body: { result: "0x200000" },
    }).decision,
    "reject",
  );
});
test("missing gas evidence cannot produce acceptance", () => {
  const r = verifyApproval(policy, p, snapshot, observation());
  assert.equal(r.decision, "inconclusive");
  assert.equal(r.checks.find((c) => c.id === "gas-estimate").status, "unknown");
});
test("malformed proposal gas rejects without crashing the verifier", () => {
  for (const gas of [null, 1.5, NaN, Infinity, "100000"]) {
    const bad = { ...p, gas };
    assert.equal(
      verifyApproval(
        policy,
        bad,
        snapshot,
        observation(bad),
        observation(bad, true),
      ).decision,
      "reject",
    );
  }
});
test("malformed mirror error bodies remain inconclusive", () => {
  for (const messages of [
    { message: "CONTRACT_REVERT_EXECUTED" },
    [null],
    "busy",
  ]) {
    const sim = {
      ...observation(),
      httpStatus: 400,
      body: { _status: { messages } },
    };
    assert.equal(
      verifyApproval(policy, p, snapshot, sim, observation(p, true)).decision,
      "inconclusive",
    );
  }
});
test("missing request metadata fails binding instead of throwing", () => {
  for (const request of [undefined, null]) {
    assert.equal(
      verifyApproval(
        policy,
        p,
        snapshot,
        { ...observation(), request },
        observation(p, true),
      ).decision,
      "reject",
    );
  }
});
