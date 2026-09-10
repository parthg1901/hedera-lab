# From requirements to verified evidence

Hedera Lab can run directly as a developer tool, or execute checks purchased through
Verifier Exchange. Direct harness use does not require x402 payment.

## Direct harness workflow

Define the application's requirements and scenario fixtures. Select simulation or
configure a local/testnet SDK adapter. Run the scenario; inspect assertions and
cleanup. The inherited coding-agent workflow can turn failures into repair findings,
modify the application, and retest while protecting scenario contracts.

Start with the [quick start](quickstart.md), then the [scenario guide](lab/README.md).
Solo/localnet runs on infrastructure you configure. The hosted instance does not
provide a Solo network just because the harness supports that adapter.

## Purchased verification workflow

1. **Provider registers the application and checks.** Catalog entries reference
   trusted workspaces and scenarios. [GrantFlow onboarding](../examples/grant-flow/README.md) demonstrates registering a
   second app through inert transaction plans. General GitHub-URL onboarding is not implemented.
2. **Customer creates a mandate.** Choose required checks, permitted execution
   environments, a service-payment budget and any live testing exposure ceilings.
   The customer delegates a scoped capability to the purchasing agent.
3. **Agent discovers and proposes coverage.** Availability filters out offline or
   unconfigured execution. Declared changes can inform package selection. Fixed
   prices and mandatory requirements are enforced by code; an optional Codex planner
   can propose coverage, but is not the authority on spending.
4. **Agent obtains and accepts a quote.** The quote binds artifacts, checks,
   repetitions, execution terms, payment price and expiry. Counteroffers adjust
   optional coverage and repetition count; mandatory checks stay intact.
5. **Service verifies capacity and settles payment.** Acceptance reserves mandate
   budget. After validating the payment proof and before settlement, the API reserves
   funded worker capacity. The agent signs client-side; Blocky402 settles testnet HBAR.
6. **Runner executes the agreed checks.** Simulation and mainnet preflight run in
   the API's executor. Registered direct testnet work goes to the dedicated worker.
   The worker supplies testnet funds and checks independent mirror observations.
7. **Customer receives the result.** The dashboard shows payment, assertions,
   transaction evidence, actual fees and fixture recovery. A failed application
   assertion is a delivered verification; infrastructure failure is inconclusive.
8. **Coding agent repairs and retests when needed.** A revised artifact requires a
   new quote and remaining authorization. The dashboard reports results; the coding
   agent edits externally. Paid retesting is not unlimited free execution.

## Two budgets, different purposes

| Authorization | Hosted example | Meaning |
| --- | --- | --- |
| Service payment | 0.02 testnet HBAR | Price paid through x402 for execution and evidence |
| Execution exposure | 70 testnet HBAR | Maximum authorized testing exposure: 60 fee ceiling + 10 temporary fixture funding |
| Observed actual fees | 16.24446757 testnet HBAR | Reconciled network fees after execution, not the quoted service price |

The provider supplies testing funds. The 70 HBAR ceiling is not a bill or deposit
collected from the buyer. Unrecovered fixture funds can include fixture-paid fees;
do not add those again to the reported network-fee total. Prices and estimates are
provider-defined examples, not established commercial pricing.

## What the user can choose today

| Environment | Hosted availability | What it establishes |
| --- | --- | --- |
| Simulation | Available | Behavior under the simulator's limited semantics and controlled faults |
| Solo/localnet | Unavailable here; independently verified on a laptop | Real SDK behavior against that configured local network |
| Testnet | Available through the dedicated worker | Real registered HTS/HCS transactions, mirror assertions and cleanup |
| Mainnet preflight | Available for the registered approval package | Read-only observations, call simulation and gas estimate; no mainnet submission |

The customer permits environments and the agent selects compatible packages. The
executor derives the actual environment from registered configuration. Payment on
testnet does not automatically select testnet application execution.

## Failure and access boundaries

Unavailable work is rejected before charging. Unknown settlement retains its
reservation for reconciliation; blind repayment is blocked. Completed worker jobs
can be retrieved repeatedly without new execution. An in-flight worker crash keeps
uncertain work for operator recovery rather than automatically replaying writes.

The current dashboard is private and live signing happens in the purchasing client,
not the browser. The hosted worker accepts registered direct scenarios, not arbitrary
customer commands. See [operations](operations/README.md) and [execution contracts](verification/EXECUTION-CONTRACTS.md).
