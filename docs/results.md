# Results and reproduction

This page summarizes the demonstrated behavior without checking generated reports,
agent transcripts or repeated screenshots into the source tree. Run the commands
below to produce fresh evidence under `.harness/runs/`.

## Engineering baseline

The 2026-09-10 onboarding release passed **318 nonbrowser tests**, with three
platform-specific skips and zero failures. The previous browser run passed **13
tests**. Counts describe regression tests, not live transactions.

```sh
npm test
npm run test:browser
```

## Paid verification and repair

GrantFlow's ordinary tests passed 4/4 while its payout logic sent Alice 0.25 HBAR
instead of the approved 0.75. Independent paid testnet verification failed. A coding
agent repaired the recipient selection; protected inputs and checks were unchanged.
The revised application then passed a second paid verification.

| Measurement | Recorded result |
| --- | --- |
| Service payment | 0.01 testnet HBAR per run; 0.02 total |
| Provider network fees | 4.61803008 testnet HBAR across both runs |
| Independent checks | Recipient balances, HCS batch message and fixture cleanup |
| Cleanup | Six accounts and two topics deleted |

The two payment transaction IDs are
`0.0.7162784@1788796919.336530972` and
`0.0.7162784@1788797690.244656335`, settled through Blocky402 to receiver
`0.0.10396075`. These public identifiers are not credentials.

This was a controlled-defect demonstration, not an unbiased accuracy benchmark.
The example prices are illustrative and do not establish commercial viability.
The historical comparison with the original Harness did not show a universal
accuracy advantage: both arms passed all primary suites in the six-session coding
comparison; exploratory combined-fault grading was 9/12 upstream and 11/12 Lab.

Start with [GrantFlow](../examples/grant-flow/README.md) for local reproduction.
Paid execution additionally requires matching provider registration, funded
accounts and explicit payment authorization; it is not a credential-free demo.

## Network and recovery coverage

Real testnet and single-node Solo runs exercised SDK operations, browser purchase
and check-in, independent mirror queries, graceful restart and Linux worker
SIGKILL recovery. The tested recovery paths reused original transaction IDs,
returned receipts to eight concurrent callers and observed one attendance message.

These tests kept the network alive. They do not prove whole-cluster-loss recovery,
behavior across a Solo reset, distributed ownership or universal exactly-once
execution. Missing evidence remains pending; in-flight hosted worker crashes can
require operator recovery. See [recovery](lab/RECOVERY.md).

## Assisted onboarding

```sh
npm run build
node scripts/onboarding-eval.mjs
```

The script copies the [team-payouts example](../examples/team-payouts/README.md)
to a temporary project and invokes the real CLI:

| Case | Result |
| --- | --- |
| Initialize with approved 0.34 / 0.67 HBAR payouts | PASS |
| Change the pool input while keeping approved amounts fixed | FAIL |
| Restore the original input and rerun the reviewed contract | PASS |

No application source or Lab files were handwritten during that onboarding flow.
The interactive walkthrough required five default confirmations, one approved-amount
answer and execution consent. This was a purpose-built fixture, not an independently
sourced unfamiliar repository or a human usability study. Only supported JavaScript
HBAR payout shapes are automatically adapted; provider registration remains manual.

## Evidence policy

Generated JSON, HTML reports, recordings and agent logs belong in ignored run
folders or a separately reviewed release attachment. Test fixtures and runnable
configuration remain in the repository. Full historical experiments were preserved
in the private development archive during cleanup; they are not part of the compact
release branch. Do not claim those attachments are publicly available until they
have actually been published.

The primary release focuses on the Harness improvement and agent skill. Public
source and a narrated demo remain release tasks. Public HTTPS and another externally
paid request are optional follow-up work for the AI payments entry, whose eligibility
should not be assumed from private-only results. See [release checklist](submission.md).
