# GrantFlow: register a second application

GrantFlow prepares HBAR payouts for approved community grants. It has no wallet or
network code: `grant-service.mjs` produces an inert plan, and the provider's Lab
worker executes it against disposable accounts. Signing keys never enter this app.

## Local onboarding

From a built Hedera Lab checkout:

```sh
node --test examples/grant-flow/test/application.test.mjs
node examples/grant-flow/build-plan.mjs
node dist/index.js lab run examples/grant-flow/scenarios/simulated.yaml --workspace examples/grant-flow
```

The repaired version should pass both ordinary application tests and independent
recipient-balance checks. The recorded demonstration starts from a deliberately
faulty recipient-ordering implementation; its ordinary tests pass but independent
verification fails. The historical results are summarized in [results](../../docs/results.md).

## What the files do

| File | Role |
| --- | --- |
| `grants.json` | Customer-approved recipient/amount pairs, deliberately in a different order from the directory |
| `grant-service.mjs` | Application logic that prepares the payouts |
| `build-plan.mjs` | Compiles that output to `payout-plan.json` without contacting a network |
| `test/application.test.mjs` | Ordinary application checks; their ordering-coverage gap is part of the comparison |
| `scenarios/simulated.yaml` | Protected expected balances and audit assertions against simulation |
| `scenarios/testnet.yaml` | The same business assertions against real testnet |
| `catalog.json` | Provider registration and fixed service/funding terms |

Alice is approved for 0.75 HBAR and Bob for 0.25. Both fixtures start with 1 HBAR.
The treasury pays transaction fees, so the protected recipient balances must become
1.75 and 1.25 respectively. A correct total of 1 HBAR is insufficient evidence.

## Register your own plan-producing application

1. Give the app a small, explicit input contract. Build its JSON output outside the
   signing worker. Preserve the source and input alongside the output.
2. Define fresh named account/token/topic fixtures in a protected scenario.
3. Reference each plan operation exactly once with `planOperation: {file: payout-plan.json, index: 0}`.
   Every output operation must be covered. The plan uses `schemaVersion: 1` and an
   `operations` array of supported Lab operations; see the [plan reference](../../docs/reference/application-plans.md).
4. Add assertions derived from customer requirements, independently of the app's
   generated recipients/amounts. Do not generate expected balances from the plan.
5. Run ordinary tests, build the plan, then run Lab in simulation. Fix defects before
   requesting a real network run unless intentionally demonstrating a paid failure.
6. Register the workspace and protected scenario in a catalog like `catalog.json`.
   Configure live funding terms if using testnet. Deploy the same immutable source,
   plan and scenario to the API and worker; their fingerprints must agree.
7. Keep customer, provider execution and payment receiving credentials separate.
   The worker checks the entire plan before funding fixtures and executes only
   supported operations referring to declared fixture aliases.
8. After a revision, rebuild the plan and obtain a fresh quote. For an image update,
   drain the worker first and use a fresh build-specific worker data volume if its
   registered artifact identity changed. Retain old state for unresolved jobs; do
   not delete journals to bypass identity or ownership checks.

## Hosted registration

The grant API uses this catalog and its own durable store. The shared worker uses
`examples/verification/worker-catalog.json`, containing both the original packages
and GrantFlow. One worker serializes both services' reservations against the same
funded execution account. Do not start independent workers against that account.

The recorded private grant service uses loopback port 4320. Reproduction and paid
before/after evidence are documented under [results](../../docs/results.md).
The package costs 0.01 testnet HBAR per run and authorizes at most 31 testnet HBAR
of provider exposure (24 fee ceiling + 7 fixture funding). Actual fees are reported
separately. These are example prices and bounds, not commercial estimates.

This verifies a prepared transaction plan, not an application UI or live input
collector. Browser workflows remain available through the existing Lab interface;
arbitrary commands and application imports remain forbidden on the signing worker.
