# Release checklist

The primary submission is **Improve the Hedera Harness**: agent-assisted integration,
independent ledger verification and repair. x402 remains an optional implemented
feature, demonstrated on a private deployment. Public payment-service hosting is
not a prerequisite for this source release.

Completed in source:

- Portable Hedera Lab skill, local scenarios and assisted payout onboarding.
- Real testnet and single-node Solo execution/recovery tested.
- Optional paid testnet verification and repair demonstrated through Blocky402.
- Concise README, quick start, technical reference, attribution and license.

Before public submission:

1. Review the compact release branch and reachable history for private data.
   Publish only intended branches/tags; repository visibility also exposes other refs.
2. Decide whether to replace the existing private default branch or publish a fresh
   repository from the reviewed release branch. Preserve the private development
   archive separately. Do not force-push or publish without the owner's decision.
3. Record a narrated demo of five minutes or less: the agent uses the skill, connects
   the real application, runs verification, investigates a failure, repairs the app
   and passes the unchanged checks. Label the actual execution environment.
4. Publish the reviewed source and any selected sanitized evidence attachments.
   Update links and status to match what is actually public.

## Optional AI payments entry

The existing code, architecture and private live-payment results can support an
additional entry. Its qualification requirements include hosting a live x402
service; do not assume a private-only demonstration qualifies. If pursuing full
hosted-service eligibility later, make the endpoint accessible, repeat a real paid
request externally and include that flow in the video. Public HTTPS work is paused.

Check the event's final requirements before submitting. Do not claim a public
endpoint, upstream PR, evidence attachment or video until it exists.
