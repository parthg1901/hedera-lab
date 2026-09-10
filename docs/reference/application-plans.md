# Application transaction plans

A registered application can prepare an inert JSON plan outside the signing
worker. Lab validates and snapshots the plan before provisioning any fixtures,
then executes supported operations and checks protected assertions. This adds
application-output verification to the direct scenario runner without importing
application JavaScript beside a signing key.

```json
{
  "schemaVersion": 1,
  "operations": [
    {"type": "transferHbar", "actor": "treasury", "to": "alice", "amount": 0.75}
  ]
}
```

Reference the operation in the protected scenario:

```yaml
- id: approved-payout
  planOperation: {file: payout-plan.json, index: 0}
- id: recipient-balance
  assert: {type: hbarBalance, account: alice, min: 1.75, max: 1.75}
```

Account names refer only to declared disposable fixtures. Paths are relative to the
registered workspace. Plans accept only `schemaVersion` and `operations`; each
operation uses the strict existing Lab schema. No module imports, commands, external
account IDs or arbitrary HTTP requests are accepted.

Limits: 64 KiB per file, 1–20 operations per plan, at most 20 plan files, no symlinks
or traversal paths. All plan operations must be referenced exactly once. Missing
or malformed plans fail readiness before payment and load before any fixture funding.
The runner uses its loaded snapshot and records each file's SHA-256 under
`applicationArtifacts`. Exchange also binds source, inputs, plan and scenario into
its workspace fingerprint, checked around execution.

These controls assume trusted provider registration and immutable deployed files;
they are not a sandbox for untrusted arbitrary repositories. The operator must
establish that the plan is reproducibly generated from the registered app/input.
The [GrantFlow onboarding example](../../examples/grant-flow/README.md) demonstrates
ordinary tests, plan generation, independent checks and a paid repair workflow.
