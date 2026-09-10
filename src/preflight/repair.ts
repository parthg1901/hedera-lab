import {
  address,
  encodeApproval,
  uint,
  validatePolicy,
  type Policy,
  type Proposal,
} from "./model.js";

/** Encoding is deterministic; successful construction is not verification. */
export function constructApproval(
  policy: Policy,
  intent: { spender: string; allowance: string; gas: number },
): Proposal {
  validatePolicy(policy);
  if (
    !intent ||
    Object.keys(intent).sort().join(",") !== "allowance,gas,spender"
  )
    throw new Error(
      "Expected only spender, allowance and gas; raw calldata overrides are forbidden",
    );
  if (address(intent.spender) !== address(policy.spender))
    throw new Error("Spender violates customer policy");
  const amount = uint(intent.allowance);
  if (amount < uint(policy.minAllowance) || amount > uint(policy.maxAllowance))
    throw new Error("Allowance violates customer policy");
  if (
    !Number.isSafeInteger(intent.gas) ||
    intent.gas < 21000 ||
    intent.gas > policy.maxGas
  )
    throw new Error("Gas violates customer policy");
  return {
    network: policy.network,
    from: address(policy.owner),
    to: address(policy.token),
    data: encodeApproval(intent.spender, intent.allowance),
    value: "0",
    gas: intent.gas,
  };
}
