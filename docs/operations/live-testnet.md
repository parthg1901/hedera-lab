# Make a real paid testnet request

This walkthrough is for a buyer using an already configured Hedera Lab API with its
dedicated testnet worker. It spends real **testnet** HBAR. For a credential-free run,
use the [local quick start](../quickstart.md).

## Provider prerequisites

The provider registers `examples/verification/service-catalog.json`, configures
Blocky402 testnet settlement to a receiving account, and starts a funded dedicated
worker. The worker has its own signing-key file and authenticated socket; the API
has the channel token but no execution signing key. See the [worker guide](../../deploy/verification/WORKER.md).

The worker needs sufficient unreserved balance for the full quoted exposure (70
HBAR for one bundled testnet-ledger run), not just its expected fee. The persistent
worker account must survive fixture cleanup. The service must expose `testnet-ledger`
as available in `/catalog` before proceeding.

This instance is private: connect through its [SSH access instructions](../../deploy/verification/WORKER.md).
A future public deployment should use HTTPS. The example URL below assumes a local
service or tunnel; it is not a published endpoint.

## Buyer prerequisites

From a built checkout, configure these variables through your shell or secret
manager. The application does not automatically load `.env` files.

| Variable/input | Meaning |
| --- | --- |
| `VERIFIER_URL` | API base URL; defaults to `http://127.0.0.1:4318` |
| `HEDERA_OPERATOR_ID` | Your funded testnet ECDSA paying account |
| `HEDERA_OPERATOR_KEY` | Its private key, supplied only to the buyer process |
| Standard input | Customer admin token supplied privately by the provider |

Do not use the provider's execution key as the buyer key. The existing script creates
a mandate, so it needs customer authorization on stdin. Delegated agents operating
an existing mandate use its scoped capability via the [agent/API workflow](../verification/README.md).

## Execute

After configuring the buyer variables, set `VERIFIER_CUSTOMER_TOKEN_FILE` to your
private local customer-token file and run:

```sh
node scripts/verification-worker-eval.mjs < "$VERIFIER_CUSTOMER_TOKEN_FILE"
```

The script creates a 0.02 HBAR service mandate with a 70 testnet HBAR execution
ceiling, negotiates coverage, accepts a quote, pays through x402, polls the worker
result and checks that it passed with reconciled funding. It performs a new purchase
each time you invoke it; do not rerun it merely to view an existing result.

## Inspect the result

Expected terminal output includes an output directory, `state: "complete"`,
`passed: true`, a real payment transaction ID and reconciled funding.

The output directory contains:

- `report.json`: quote, paid job and execution evidence; inspect before sharing.
- `capability.json`: private mandate authorization; never publish this file.

Open the dashboard's **Open an existing mandate**, enter the mandate ID and scoped
capability from that private file, and inspect the result. Live signing happens in
the client, not in the dashboard. The report should show the correct customer NFT
ownership, attendance message and successful fixture cleanup.

## Spending and failure interpretation

The 0.02 HBAR service payment is separate from provider-supplied testnet execution
funds. A prior run used 16.24446757 HBAR in actual fees and recovered 9.36916727 of
10 fixture HBAR; future fees and timing may differ. The 70 HBAR exposure is an upper
bound, not an additional customer charge. Payment-transaction fees and any model
usage are separate from application execution reconciliation.

Offline or insufficiently funded workers cannot accept paid work. If payment or
execution is ambiguous, inspect the existing job and follow the operator recovery
procedure. A paid application failure is a delivered result; missing infrastructure
evidence is inconclusive. Never blindly create another payment or live write to
resolve uncertainty.

[Recorded hosted run](../results.md) ·
[Separate live paid repair demonstration](../results.md)
