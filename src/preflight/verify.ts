import {
  address,
  decodeApproval,
  digest,
  uint,
  validatePolicy,
  type Check,
  type Observation,
  type Policy,
  type Proposal,
  type Snapshot,
} from "./model.js";
export function verifyApproval(
  policy: Policy,
  proposal: Proposal,
  snapshot: Snapshot,
  simulation: Observation,
  estimate?: Observation,
) {
  validatePolicy(policy);
  const checks: Check[] = [];
  const check = (
    id: string,
    ok: boolean,
    message: string,
    expected?: unknown,
    observed?: unknown,
  ) =>
    checks.push({
      id,
      status: ok ? "passed" : "failed",
      message,
      expected,
      observed,
    });
  check(
    "network",
    proposal.network === policy.network && snapshot.network === policy.network,
    "Proposal and snapshot must use the customer network",
    policy.network,
    proposal.network,
  );
  for (const [id, actual, expected] of [
    ["caller", proposal.from, policy.owner],
    ["token", proposal.to, policy.token],
  ] as const) {
    let ok = false;
    try {
      ok = address(actual) === address(expected);
    } catch {}
    check(id, ok, "Must match customer-authorized " + id, expected, actual);
  }
  let decoded: ReturnType<typeof decodeApproval> | undefined;
  try {
    decoded = decodeApproval(proposal.data);
    check("method", true, "Canonical approve(address,uint256) call");
    check(
      "spender",
      decoded.spender === address(policy.spender),
      "Only the customer-authorized spender may receive allowance",
      policy.spender,
      decoded.spender,
    );
    check(
      "allowance",
      uint(decoded.allowance) >= uint(policy.minAllowance) &&
        uint(decoded.allowance) <= uint(policy.maxAllowance),
      "Allowance must remain inside the customer range",
      { min: policy.minAllowance, max: policy.maxAllowance },
      decoded.allowance,
    );
  } catch (e) {
    check("method", false, e instanceof Error ? e.message : "Invalid calldata");
  }
  check(
    "native-value",
    proposal.value === "0",
    "Approval must send no native HBAR",
    "0",
    proposal.value,
  );
  check(
    "gas-limit",
    Number.isSafeInteger(proposal.gas) &&
      proposal.gas >= 21000 &&
      proposal.gas <= policy.maxGas,
    "Gas limit must respect the customer ceiling",
    policy.maxGas,
    proposal.gas,
  );
  const bound = (o: Observation, est: boolean) =>
    !!o.request &&
    o.request.block === snapshot.block &&
    o.request.from === proposal.from &&
    o.request.to === proposal.to &&
    o.request.data === proposal.data &&
    String(o.request.value) === proposal.value &&
    o.request.gas === proposal.gas &&
    o.request.estimate === est;
  check(
    "simulation-binding",
    bound(simulation, false),
    "Simulation must describe this exact proposal at the fixed block",
  );
  const body = simulation.body as any;
  const result = body?.result;
  if (simulation.httpStatus === 200 && typeof result === "string")
    check(
      "simulation",
      /^0x0{63}1$/.test(result),
      "SAUCE approval simulation must return ABI true",
      "0x" + "0".repeat(63) + "1",
      result,
    );
  else if (
    simulation.httpStatus === 400 &&
    Array.isArray(body?._status?.messages) &&
    body._status.messages.some(
      (m: any) => m?.message === "CONTRACT_REVERT_EXECUTED",
    )
  )
    check("simulation", false, "Contract simulation reverted", undefined, body);
  else
    checks.push({
      id: "simulation",
      status: "unknown",
      message: "Mirror execution unavailable or response unsupported",
      observed: { status: simulation.httpStatus, body },
    });
  if (estimate) {
    check(
      "estimate-binding",
      bound(estimate, true),
      "Gas estimate must describe this exact proposal at the fixed block",
    );
    const gas = (estimate.body as any)?.result;
    if (
      estimate.httpStatus === 200 &&
      typeof gas === "string" &&
      /^0x[0-9a-f]+$/i.test(gas)
    ) {
      check(
        "gas-estimate",
        Number.isSafeInteger(proposal.gas) &&
          BigInt(gas) <= BigInt(proposal.gas) &&
          BigInt(gas) <= BigInt(policy.maxGas),
        "Estimated gas must fit transaction and customer limits",
        { transaction: proposal.gas, customer: policy.maxGas },
        BigInt(gas).toString(),
      );
    } else
      checks.push({
        id: "gas-estimate",
        status: "unknown",
        message: "Gas estimate unavailable",
        observed: estimate.body,
      });
  } else {
    checks.push({
      id: "gas-estimate",
      status: "unknown",
      message: "Gas estimate is required for acceptance",
    });
  }
  const decision = checks.some((c) => c.status === "failed")
    ? "reject"
    : checks.some((c) => c.status === "unknown")
      ? "inconclusive"
      : "accept";
  const content = {
    schemaVersion: 1,
    integration: policy.integration,
    mode: "mainnet-state-simulation",
    decision,
    policyHash: digest(policy),
    proposalHash: digest(proposal),
    snapshot,
    decoded,
    checks,
    simulation,
    ...(estimate ? { estimate } : {}),
    limitations: [
      "Mirror simulation does not submit a transaction or prove possession of the caller key.",
      "Approval checks do not verify swap execution, liquidity, recipient outcomes or future state.",
      "Customer must authorize policy addresses; this report does not establish their trustworthiness.",
    ],
  };
  return { ...content, reportHash: digest(content) };
}
