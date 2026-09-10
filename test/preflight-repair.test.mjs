import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { constructApproval } from "../dist/preflight/repair.js";
import { decodeApproval } from "../dist/preflight/model.js";
const policy = JSON.parse(
  await readFile(new URL("../examples/preflight/policy.json", import.meta.url)),
);
const intent = {
  spender: policy.spender,
  allowance: policy.minAllowance,
  gas: policy.maxGas,
};
test("typed repair encodes boundary and 200 deterministic amounts as exact ABI words", () => {
  const maximum = (1n << 256n) - 1n;
  const wide = {
    ...policy,
    minAllowance: "0",
    maxAllowance: maximum.toString(),
  };
  let seed = 42n;
  for (const amount of [
    0n,
    1n,
    maximum,
    ...Array.from(
      { length: 200 },
      () => (seed = (seed * 6364136223846793005n + 1n) & maximum),
    ),
  ]) {
    const p = constructApproval(wide, {
      ...intent,
      allowance: amount.toString(),
    });
    assert.equal(p.data.length, 138);
    // Independently read both ABI words rather than rely on the production decoder.
    assert.equal(
      p.data.slice(10, 74),
      policy.spender.slice(2).padStart(64, "0"),
    );
    assert.equal(BigInt("0x" + p.data.slice(74)), amount);
  }
});
test("construction rejects changed authority, overbudget intent and raw overrides", () => {
  for (const bad of [
    { ...intent, spender: "0x" + "0".repeat(40) },
    { ...intent, allowance: "0" },
    { ...intent, allowance: (BigInt(policy.maxAllowance) + 1n).toString() },
    { ...intent, allowance: "1e8" },
    { ...intent, gas: policy.maxGas + 1 },
    { ...intent, gas: 21000.5 },
    { ...intent, data: "0x" },
    { ...intent, from: policy.owner },
  ])
    assert.throws(() => constructApproval(policy, bad));
});
test("both previously malformed model repairs are rejected and typed replacements decode", async () => {
  const failures = JSON.parse(
    await readFile(new URL("./fixtures/preflight/malformed-approval-data.json", import.meta.url)),
  );
  assert.equal(failures.length, 2);
  for (const data of failures) {
    assert.equal(data.length, 134);
    assert.throws(() => decodeApproval(data));
    assert.deepEqual(decodeApproval(constructApproval(policy, intent).data), {
      spender: policy.spender,
      allowance: policy.minAllowance,
    });
  }
});
