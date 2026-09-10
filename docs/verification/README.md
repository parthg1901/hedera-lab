# Hedera Lab — Verifier Exchange

Verifier Exchange is the paid verification component of **Hedera Lab**.

Independent verification for agent-built Hedera applications. A customer authorizes
requirements and a spending ceiling. A purchasing agent negotiates optional coverage,
accepts a fixed-price quote, pays for execution, and receives ledger-backed evidence.

The implementation extends Hedera Lab rather than replacing its scenario runner.
This is an operator-managed service with registered scenario packs and workspaces,
not an arbitrary-code hosting sandbox or an open marketplace of external providers.

## Run it

```sh
npm ci
npm run build
node dist/index.js verify demo
node dist/index.js verify serve --port 4318
```

Open http://127.0.0.1:4318. If `VERIFIER_ADMIN_TOKEN` is unset, the service writes a
random customer token to its private store directory and prints that file's path.
Paste the token into the customer mandate form. Authorize a budget, request a quote,
accept it, and execute with simulated payment. Tokens stay in browser memory.

The dashboard follows authorization → coverage → evidence, with live budget totals
and expandable reports. See the [UI design notes](../results.md) and
[desktop preview](../assets/dashboard.png).

The default catalog uses simulated ledger scenarios and needs no browser. For
actual application UI testing:

```sh
npx playwright install --with-deps chromium
node dist/index.js verify serve --config examples/verification/browser-catalog.json
```

The pricing is illustrative, not a profitability estimate. A repetition runs the
same deterministic scenario with fresh fixtures; it does not imply new fuzz cases
or broader coverage. Live fixture costs and model inference costs are additional
operator costs, not automatically included in the quoted service fee.

## Mainnet-state preflight

`examples/preflight/catalog.json` adds a SAUCE approval pack using transient
mainnet mirror execution and gas estimation. Customer caller/token/spender/allowance
constraints are checked independently of execution success. This mode does not
submit mainnet transactions; payment settlement is configured separately. See the
[preflight guide](../preflight/README.md) and [paired comparison](../results.md).

## Change-aware coverage

Use `examples/verification/risk-catalog.json` for browser purchase, mirror lag,
purchase replay, attendance replay, eight-way concurrent purchase, and lost-response
recovery. Use `examples/verification/payment-catalog.json` to test the Exchange
implementation for payment replay, competing budget reservations, unknown settlement,
and paid service delivery. Protocol drivers execute real application/service code in
subprocesses with simulated ledger or settlement faults; they are not testnet tests.
Subprocesses receive no wallet environment, but are not a hardened arbitrary-code sandbox.

The `timeout-recovery` package now executes four combined-fault checks: lost transfer
response with stale mirror data, lost HCS response with retries, eight concurrent
check-ins, and retry after an explicit wallet decline. It verifies ledger state and
submission counts. Its existing illustrative price is unchanged. Run the same checks
without the Exchange using `node scripts/ticket-stress.mjs <workspace>`.

Unknown HCS delivery must remain pending when receipt reconciliation is unavailable;
the example prevents blind resubmission but does not implement durable reconciliation
or exactly-once behavior across process restarts. These checks caught an unnecessary
transfer resubmission in naturally generated code that passed the original Harness
and eight earlier suites. See [expanded testing and evidence](../results.md).

The dashboard lets customers choose mandatory checks. A declared file list, summary
and optional patch are classified into risk categories. Recommendations buy required
checks first, then affordable relevant checks, once each. This is a deterministic
heuristic, not semantic code analysis or proof of complete coverage. The supplied
change description is hashed into the contract separately from actual workspace
and scenario fingerprints.

```sh
node dist/index.js verify serve --config examples/verification/payment-catalog.json
# changes.json: {"files":["payment.ts"],"summary":"Fix payment retries after a timeout"}
node dist/index.js verify agent --url http://127.0.0.1:4318 --mandate MANDATE_ID --changes changes.json --allocation 2400000 --pay yes
```

`--allocation` limits this procurement within the remaining mandate budget. For
example, a 0.024 HBAR allocation buys required delivery (0.005), replay (0.007),
and unknown-settlement checks (0.012). Concurrency coverage is explicitly omitted.

## Agent negotiation

A deterministic purchasing policy works without a model account. An optional Codex
planner produces a structured counteroffer using a locally authenticated Codex CLI.
The price is recalculated and mandatory coverage and budget are validated in code.
No payer key or mandate capability is passed in its prompt or subprocess environment.

```sh
# Set VERIFIER_CAPABILITY to the capability issued when the customer created a mandate.
node dist/index.js verify agent --url http://127.0.0.1:4318 --mandate MANDATE_ID --pay yes
# Model-backed planning:
node dist/index.js verify agent --url http://127.0.0.1:4318 --mandate MANDATE_ID --planner codex --pay yes
# Complete local simulation with model-driven counteroffer:
node dist/index.js verify demo --planner codex --store .harness/runs/model-demo
```

The provider is a deterministic quoting/execution service, not a second LLM. Its
fixed catalog prices prevent invented discounts. Counteroffers may change selected
optional packs and repetitions; all customer-required packs remain mandatory.
There are up to five rounds per negotiation chain. Quotes expire after five minutes.
The mandate's `reserve` is an untouchable safety buffer; it is not a promised free
rerun. New revisions/reruns require a new accepted quote and available budget.

## Real x402 testnet payments

Set `VERIFIER_PAY_TO` to the verifier's receiving account, then:

```sh
node dist/index.js verify serve --mode testnet --store .harness/runs/testnet-service
```

The paying agent needs `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` (ECDSA) in its
own process. The service itself needs no payer private key for payment settlement.
Customer mandate creation requires the service's admin capability; this is spending
authorization, not an API subscription. Discovery is public at `/catalog`.

1. Customer creates a mandate; receives a scoped builder capability.
2. Agent requests a quote and sends a counteroffer.
3. Accepting the quote reserves tinybars atomically.
4. `POST /jobs/:id/pay` returns HTTP 402 and `PAYMENT-REQUIRED`.
5. The client signs a Hedera transfer whose memo binds the contract hash.
6. It retries with `PAYMENT-SIGNATURE` (legacy `X-PAYMENT` is also accepted).
7. The service verifies and settles through Blocky402, then queues the Lab job.
8. The agent retrieves the result without paying again.

This service adds mandatory memo binding to its x402 payment requirements; the
included payer supports that extension. Generic x402 clients that ignore it will
be rejected. Network/asset scope is currently exact HBAR on Hedera testnet.

Optional HCS evidence anchoring: set `VERIFIER_HCS_TOPIC_ID` and
`VERIFIER_AUDIT_OPERATOR_ID` / `VERIFIER_AUDIT_OPERATOR_KEY`. The service records
contract hash, report hash, and payment transaction. An anchor proves publication
and linkage, not that a verifier's assertions are inherently trustworthy. Audit
failures are reported separately and do not fabricate an anchor or repeat payment.

## API

| Method/path | Authority | Purpose |
|---|---|---|
| GET /catalog | Public | Discover packs and prices |
| POST /mandates | Customer admin bearer | Create immutable required checks and budget |
| GET /mandates/:id | Builder capability | Inspect quotes, jobs, spend and reservations |
| POST /recommendations | Builder capability | `{mandateId,changes:{files,summary,patch?},allocation?}` |
| POST /quotes | Builder capability | `{mandateId,selection:[{pack,repetitions}],parent?,changes?}` |
| POST /quotes/:id/accept | Builder capability | Reserve budget; idempotent per quote |
| POST /jobs/:id/pay | Builder capability + payment proof | Settle and execute |
| GET /jobs/:id | Builder capability | Retrieve existing delivery |
| POST /jobs/:id/cancel | Builder capability | Release an unsubmitted reservation |
| POST /jobs/:id/reconcile | Customer admin bearer | Resolve uncertain payment from mirror evidence |

Mandate body: `{target,revision,required:[packId],ceiling:"4000000",reserve:"0"}`.
Amounts are integer tinybars as strings. `revision` is a customer label; each quote
also records actual workspace/scenario content hashes. Artifact changes before or
during execution prevent an unqualified completed result.

## Failure and recovery semantics

- Budget reservations and payment intent are fsynced before settlement.
- Concurrent acceptance cannot overspend a mandate. Duplicate payment requests
  for a job share one settlement attempt; a proof cannot buy a second job.
- Transport uncertainty retains the reservation in `payment_unknown`.
- Reconciliation checks the original transaction's memo and exact payer/recipient
  transfers on the testnet mirror. Missing evidence remains unknown.
- Restart resumes paid-but-unstarted jobs. Interrupted execution is marked as an
  infrastructure failure; the service does not replay potentially completed writes.
- Execution failure after settlement remains charged and requires operator
  remediation. Automatic refunds, escrow, and dispute resolution are not implemented.
- Store ownership is exclusive to one process. After an unclean process exit,
  inspect `service.lock`, confirm its recorded process is no longer running, and
  remove only that stale lock before restart. Keep the state and Lab recovery files.
- The local hash-chained event log detects accidental record corruption. Without
  external anchors, an operator could rewrite it; it is not an independent trust root.

## Execution environments and funding

Read the [buyer flow and execution contract guide](EXECUTION-CONTRACTS.md) for
service pricing, separate testing funds, enforced fee ceilings, actual fee evidence,
and the read-only mainnet package. The private catalog explicitly marks live
Solo/testnet execution unavailable when no operator is configured.

## Verification and deployment

```sh
npm test
npm run test:browser
node scripts/verification-eval.mjs
# Full model-driven purchase → defect → repair → retest experiment:
node scripts/verification-repair-eval.mjs
# With authorized HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY and testnet funds:
node scripts/verification-repair-eval.mjs --testnet-payment
# Real payments AND real application NFT/HCS transactions:
node scripts/verification-repair-eval.mjs --fully-live
# Three fresh agent implementations, no code defect injection:
node scripts/verification-native-eval.mjs
```

The benchmark injects three application defects and includes a correct control.
The separate untouched-generation evaluation passed all three cases; no repair
was needed. Neither experiment establishes measured LLM repair improvement. See
[results](../results.md) for demonstrated behavior and limitations.

See the [container deployment guide](../../deploy/verification/WORKER.md) for
private hosting, resource limits, secrets and recovery. Use registered trusted
workspaces and one service replica per store. Arbitrary uploads, production tenant
isolation and horizontal scaling are not provided. Public HTTPS deployment remains
a release task. [Results and limitations](../results.md) summarize the demonstrations.

## Source map

- `model.ts`, `store.ts`, `engine.ts`: contracts, budget and durable lifecycle.
- `payment.ts`, `audit.ts`: Blocky402 settlement/reconciliation and HCS anchors.
- `executor.ts`: independent Lab execution.
- `agent.ts`, `planner.ts`: policy and optional model-driven procurement.
- `server.ts`, `ui.ts`, `cli.ts`: API, customer dashboard, and command entrypoints.

References: [Blocky402 quickstart](https://blocky402.com/docs/quickstart/),
[networks](https://blocky402.com/docs/networks/),
[Codex non-interactive structured output](https://learn.chatgpt.com/docs/non-interactive-mode),
[Hedera track requirements](https://ethglobal.com/events/ethonline2026/prizes/hedera).
