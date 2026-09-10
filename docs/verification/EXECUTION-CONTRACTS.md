# What a buyer purchases

A quote now separates **service payment** from **application execution**. Paying
on testnet does not select testnet execution. A quote binds the registered target,
caller-declared revision, source/scenario fingerprints, selected checks, repetitions,
execution terms, settlement network and service price into its contract hash.

## Buyer workflow

1. Open the private dashboard through the SSH tunnel in
   [the instance guide](../../deploy/verification/WORKER.md).
2. Choose permitted execution environments and required checks. Set the service
   payment budget. For live execution, separately authorize an execution exposure
   ceiling in that network's testing HBAR.
3. Request a quote or ask the agent to propose coverage. Review the execution
   environment, service fee and funding breakdown before accepting.
4. Accept and reserve the quote. The agent signs the x402 payment on the configured
   settlement network. The browser can execute simulated payments in demo mode;
   it does not hold a live wallet key.
5. Inspect pass/fail evidence and funding reconciliation. A failed assertion is a
   delivered result, while infrastructure failure is explicitly inconclusive.

The private instance offers simulated fault/browser checks, a live read-only
mainnet approval preflight, and registered testnet ledger checks through a separate
Docker worker. Solo remains unavailable on this instance. Unavailable packages
cannot be selected through the dashboard or charged through the API. The existing
local/testnet Lab CLI remains independently usable. See the [hosted worker proof](../results.md).

## Funding terms

| Field | Meaning |
| --- | --- |
| `settlement.serviceFeeTinybar` / `price` | Fixed provider price settled through x402 |
| `execution[].terms.environment` | `simulated`, `local`, `testnet`, or `mainnet-preflight` |
| `estimatedFeeTinybar` | Provider estimate per execution; not a dynamically fetched Hedera fee quote |
| `feeCeilingTinybar` | Maximum sum of reserved SDK transaction-fee limits per execution |
| `cleanupReserveTinybar` | Part of the fee ceiling reserved exclusively for cleanup |
| `perTransactionMaxTinybar` | Default SDK maximum assigned to metered writes |
| `tokenCreateMaxTinybar` | Separate token-creation SDK maximum, within the same total fee ceiling |
| `fixtureFundingTinybar` | Initial disposable-account funding from the scenario; temporary capital, not a fee |
| `maximumExposureTinybar` | Fee ceiling plus fixture funding, conservatively including both |
| `executionExposure` | Exposure across selected repetitions, grouped by local/testnet |
| `executionCeilings` | Mandate-authorized cumulative exposure, separately denominated for each network |

The provider supplies live testing funds. They are **not added to the x402 service
price** and are not converted between local, testnet and mainnet HBAR. Testnet HBAR
consumption is not represented as a mainnet-money expense. The payer/facilitator's
payment-transaction fee is separate from application execution fees.

Illustrative bundled testnet terms: 20 HBAR fee estimate, 60 HBAR fee ceiling
(including 20 HBAR reserved for cleanup), 2 HBAR default maximum per transaction (20 HBAR for token creation), and
10 HBAR disposable fixture funding. Maximum exposure is 70 testnet HBAR per run;
this is an upper bound, not a 70 HBAR bill. Service prices and estimates remain
provider-defined examples, not measured commercial pricing.

Reservations are deliberately conservative: acceptance atomically commits maximum
exposure, so concurrent jobs cannot exceed the mandate. Cancelling an unsubmitted
job releases it. Completed runs do not automatically recycle exposure into more
writes; authorize a new mandate when appropriate. The report still shows actual
observed spending independently. This is not an escrow or automated refund system.

## Enforcement and reconciliation

The executor derives environment from the actual scenario/driver. The buyer cannot
relabel a live scenario as simulation. Readiness and execution terms are checked
at quote, acceptance, payment and execution. Missing funding configuration or
credentials blocks live packages. Live preflight checks mirror reachability,
operator public-key identity and a balance sufficient for one run's upper bound.
That readiness probe alone does not reserve funds. The hosted dedicated worker
additionally reserves funded capacity before settlement, as described in the
[worker guide](../../deploy/verification/WORKER.md). Neither guarantees against
subsequent network failure.

Each metered write sets the SDK fee maximum, disables automatic write retries and
transaction-ID regeneration, and durably records its fee reservation before
submission. Concurrent reservations serialize. Exhausting the business allowance
cannot consume the cleanup reserve. Unknown submissions retain their reservations.
The meter's journal is separate from disposable-key and receipt-recovery journals.

After cleanup, the collector queries independent mirror transaction records for
charged fees, successful initial account funding and account-delete sweep amounts.
It reports observed and complete actual totals separately. Missing, duplicate or
malformed records yield `incomplete` with `actualFeeTinybar: null`; they never
become a zero-cost success. Unrecovered fixture balance can include actor-paid
transaction fees, so it must not be added to fees as a second expense.

The ordinary Lab CLI remains unmetered unless invoked through these executor terms.
Unmetered live execution is labeled unknown in Exchange reports, not zero-cost.
No multi-host worker scheduler or arbitrary repository upload has been introduced.
Live execution must run trusted registered code in an appropriately isolated
operator-controlled environment. Do not give the shared private API a signing key
merely to turn an unavailable badge green.

## Mainnet package

`approval-preflight` uses the registered SAUCE approval policy/proposal. It reads
mainnet state, simulates the call and gas estimate, checks the authorized caller,
token, spender and allowance, and records the state reference. It submits no
mainnet transaction, requires no fixture funding and has zero application
submission fees. It does not simulate arbitrary programs, fork the whole chain,
or guarantee a future submission will succeed. The proposed transaction's gas
estimate is evidence, not money spent by this verification.

## Reproduce the user tests

```sh
npm ci
npm run build
npx playwright install chromium
node scripts/verification-contract-eval.mjs --mainnet
node scripts/verification-funding-audit.mjs /path/to/saved-testnet-report.json
npm test
npm run test:browser
```

The browser walkthrough buys a simulated purchase/check-in test, checks its contract
and report, verifies desktop/mobile rendering and then executes a real read-only
mainnet preflight. Both walkthrough payments are explicitly simulated. The funding
audit reconciles existing real testnet transaction IDs without submitting new writes.
Reports and screenshots are under `.harness/runs/execution-contract-walkthrough`.

A fresh metered testnet job also passed through the HTTP quote/accept/pay/execute
flow (simulated service payment, real application transactions). Its 20 HBAR fee
estimate reconciled to **16.14270695 testnet HBAR** actual fees. Ten HBAR funded the
fixtures; **9.37311903 HBAR** returned during cleanup. All 14 submissions reconciled.
The first attempt failed because a uniform 2 HBAR cap was insufficient for token
creation; both accounts were deleted and that failed report is preserved. A
historical token-creation record showed a 12.55942339 HBAR fee, motivating the
explicit 20 HBAR token cap within the unchanged 60 HBAR total fee ceiling.

To reproduce a new live funding run, supply an explicitly authorized funded testnet
operator through `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`, then run:

```sh
node scripts/verification-live-funding-eval.mjs
```

The script performs real testnet writes, creates disposable fixtures and cleans
them up. It prints sanitized results and saves journals under ignored `.harness`.
It does not install signing credentials in the private backend. Metered Solo uses
the same adapter path, but this change has not been rerun against a Solo deployment.

Shareable evidence: [browser/mainnet walkthrough](../results.md),
[mainnet dashboard](../assets/dashboard.png),
[fresh metered testnet pass](../results.md),
[preserved initial failure](../results.md),
and [archived fee audit](../results.md).

## Final private deployment proof

The final container completed two real 0.01 HBAR x402 testnet payments: one for
browser verification, one for mainnet preflight. Both jobs survived a forced
backend-process crash and automatic Docker restart with unchanged receipts and
report hashes. See the [paid mainnet dashboard](../assets/dashboard.png),
[mainnet payment and report](../results.md),
[browser payment and report](../results.md),
and [restart evidence](../results.md).

Validation: 289 nonbrowser passes, three platform skips, 12 browser passes, plus
the fresh live funding run and deployed paid requests described above.
