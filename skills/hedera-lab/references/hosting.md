# Hosted handoff and paid testing

Read only when the user wants a provider service or a paid test. Creating local
verification files does not require provider registration, payment or deployment.

## Provider handoff

Deliver source, representative input, build adapter, generated plan, protected
scenario and a short readable acceptance contract. The provider must establish
that rebuilding the supplied source/input produces the plan and that API and
worker deploy the same immutable artifacts. Keep the source and input inside the
registered workspace; exclude local logs, capabilities and recovery journals.

The provider chooses the catalog entry: package ID/title, workspace, scenario,
service `priceTinybar`, execution funding estimates and ceilings. Do not assign a
commercial price or invent funding approval on the customer's behalf. The wizard's
`provider-handoff.json` is a request for registration, not a runnable priced catalog.

The current worker accepts trusted registered direct testnet checks and bounded
plans, not arbitrary uploaded repositories, app imports or browser commands. The
provider performs builds outside the signing worker. Registration and image updates
are operator-managed; there is no self-service repository upload endpoint.

## Customer flow

The customer mandate identifies required checks, permitted environments, service
budget and testing exposure. The registered scenario selects the execution network;
the provider must actually offer that environment. Payment network is configured
separately. A testnet service payment does not establish testnet application execution.

A purchasing agent discovers packages, requests a quote, checks bound artifacts and
terms, accepts, signs the 402 challenge locally, and polls the resulting job.
`verify agent` creates and accepts its own quote; do not first reserve the same
budget manually in the dashboard and then tell it to create another purchase.
Use the installed CLI/API reference for flags and credentials. Wallet private keys
never belong in the scenario, prompt, plan, source, report or skill files.

A code revision needs a rebuilt plan, provider deployment of matching artifacts and
a fresh quote. Old artifact fingerprints must not authorize changed application
code. Spend only within the user's existing explicit network/budget authorization;
if authorization or required credentials are absent, finish the local artifacts and
report what is missing. Do not repeatedly prompt for permission already granted.

Report service payment separately from actual execution fees, temporary fixture
funding and recovered funds. The example provider funds network execution; an
exposure ceiling is not an immediate bill. Preserve failed verification evidence:
payment buys execution and evidence, not a guaranteed pass. Unknown settlement or
transaction receipts must be reconciled using the existing identity, not retried
as a new payment/write simply to get a conclusive result.
