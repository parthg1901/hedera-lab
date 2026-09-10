# Team payouts: onboarding example

This is an ordinary JavaScript business function with no Lab integration files.
It distributes a pool by member weights and assigns remainder cents by largest
fractional share. For the supplied 101-cent pool, designer receives 0.34 HBAR and
engineer receives 0.67 HBAR. These approved expectations follow the stated business
rule and are supplied separately to onboarding.

From a built Hedera Lab checkout, make a disposable copy of this folder, then run:

```sh
node dist/index.js lab onboard inspect --workspace /path/to/team-payouts
node dist/index.js lab onboard init --workspace /path/to/team-payouts
```

The interactive wizard discovers `payouts.mjs`, export `distribute`, and `batch.json`.
Accept those candidates, choose `transfers`, accept payer `treasury`, and enter
`designer=0.34,engineer=0.67` as the approved payouts. Consent to local execution.
No wallet, provider token, Docker installation, or model account is needed.

Review the generated `verification/CONTRACT.md`, adapter and scenario, then:

```sh
node dist/index.js lab onboard approve --workspace /path/to/team-payouts
node dist/index.js lab onboard check --workspace /path/to/team-payouts --allow-execution
```

This example was written for onboarding evaluation. It is not an independently
sourced unfamiliar repository or evidence of broad automatic framework support.
