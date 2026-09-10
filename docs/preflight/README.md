# Mainnet-state approval verification

Hedera Lab can verify a proposed **SAUCE token approval** against a fixed Hedera
mainnet block, then check whether the proposal satisfies the customer's requirements.
This is the first supported preflight integration, not a general smart-contract auditor.

No signer, private key or transaction submission exists in this adapter. Requests go
only to Hedera's mainnet mirror node. The `from` address supplies simulation context;
it does not prove that the user owns or can sign for that account.

[Measured results](../results.md): both agent arms classified 16/16 correctly; direct-API
repair passed 12/12 and Lab-assisted repair 10/12. All outcomes are preserved.

## What the service checks

- Mainnet network, customer-authorized caller and canonical SAUCE token target.
- Exact `approve(address,uint256)` selector and canonical ABI encoding.
- Customer-authorized spender and allowance within an explicit integer range.
- Zero native value and transaction gas within the customer's ceiling.
- A successful simulated ABI `true` return and an estimate fitting the gas limit.
- Binding of both observations to the exact proposal and the same fixed block.

The supported SAUCE token is `0.0.731861`. The example authorizes SaucerSwap's V1
Router V3, `0.0.3045981`, as spender. Its public example caller was selected from a
SAUCE holder list to provide an associated account for simulation. It is not a wallet
we control. Example amounts are token base units, not HBAR fees.

A successful `approve` simulation does not prove that an eventual swap will execute,
that liquidity or minimum-output constraints will hold, or that the spender is safe.
No swap, wrapping, withdrawal, or actual mainnet execution is implemented here.

## Run a standalone preflight

```sh
npm ci
npm run build
node dist/index.js preflight examples/preflight
```

Input files in the registered workspace:

| File | Purpose |
|---|---|
| `policy.json` | Customer requirements: caller, token, spender, allowance range and gas ceiling |
| `proposal.json` | Proposed network, from/to, calldata, native value and gas |
| `scenario.json` | Operator-registered paths to the two input files |

The command resolves a block once, sends transient execution and gas-estimate
requests for that same block, and saves a JSON report. Exit codes are 0 for acceptance,
1 for rejection and 2 for inconclusive infrastructure results. Network errors may
exit through the general CLI error path. The report identifies the block/hash,
request/response pairs, findings, proposal/policy hashes and report hash.

## Buy it through the existing Exchange

```sh
node dist/index.js verify serve --config examples/preflight/catalog.json
```

The dashboard and purchasing agent use the existing quote, reservation, x402 and
job-delivery flow. The registered pack runs real **mainnet-state simulation** while
the default service payment remains **simulated**. The two modes are separate.
For actual testnet fee settlement, follow the existing [payment setup](../verification/README.md#real-x402-testnet-payments)
and start with `--mode testnet`. Mainnet funds are never moved by this preflight.

The listed 0.01 HBAR service fee is illustrative. It is not a network gas charge.
A public mirror call is already available directly; our evaluation compares whether
structured customer-policy checks provide additional benefit.

Policies and input paths are operator-registered files. Customers must approve the
policy before registration; the API does not yet offer arbitrary preflight uploads
or a separately signed policy-submission flow. Existing quote fingerprints protect
the registered files against changes after quotation.

## Reproduce the comparison

```sh
npm run build
node scripts/preflight-collect.mjs .harness/runs/preflight-new
# Requires an authenticated Codex CLI:
node scripts/preflight-agent-eval.mjs .harness/runs/preflight-new
```

Collection writes its protocol before making requests. It preserves all 16 constructed
cases and resolves one fixed mainnet block for all execution and gas estimates.
Infrastructure failures remain visible and prevent the paired agent evaluation.
A rerun requires a fresh output directory; existing registered runs are not overwritten.

The direct arm receives the exact policy, ABI, proposal, fixed block, and raw mirror
responses. The Lab arm receives the same data plus Lab's structured report. Each arm
uses a fresh Codex process with the same prompt, schema, default model and time limit.
The first arm alternates by case. Expected answers and descriptive case IDs are not
shown to the model. Each call returns an original-proposal decision and at most one
corrected proposal. No model call is retried or silently discarded.

An independent grader checks corrected fields and ABI values without calling the Lab
verifier, then checks live or cached observations at the original block. Cache hits
are counted separately from new mirror calls. Usage counts and wall-clock durations
are recorded; authenticated CLI usage is not assigned an invented dollar price.
Model tool use or execution errors are recorded as protocol deviations.

This is a small, constructed, single-run comparison. It cannot establish commercial
demand, a general model error rate, production safety or statistical superiority.
The useful baseline is the **agent interpreting the full API evidence**, not merely
an HTTP-success check.

## Sources

- [Hedera contract-call API](https://docs.hedera.com/api-reference/contracts/invoke-a-smart-contract): transient execution, historical blocks and gas estimation.
- [SaucerSwap contract deployments](https://docs.saucerswap.finance/developers/contracts): canonical token and router IDs.
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): structured subprocess output.

## Construct repairs without hand-written calldata

```sh
node dist/index.js preflight construct examples/preflight/policy.json examples/preflight/intent.json
```

The intent contains only `spender`, `allowance` (an integer decimal string), and
`gas`. The constructor validates these choices against the unchanged customer
policy, supplies the authorized network/caller/token and zero native value, and
encodes the ABI words deterministically. It rejects out-of-policy inputs and extra
fields, including raw calldata overrides. It never silently clamps the amount.

Construction is not acceptance. Save the emitted proposal into the registered
workspace and run preflight again to obtain execution and gas evidence for it.
The constructor performs no network access or signing.

The follow-up evaluation gives this same constructor to **both** agent arms:

```sh
node scripts/preflight-typed-agent-eval.mjs .harness/runs/preflight-new
```

It writes a separate `agents-typed-v2` directory and preserves the original raw-ABI
comparison. The follow-up changes the output protocol, so improvements cannot be
attributed to Lab evidence alone. [Follow-up testing](../results.md) records results
and limitations, including the separate actual-Harness experiment.
