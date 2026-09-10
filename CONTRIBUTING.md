# Contributing

Use Node.js 24 and run `npm ci` followed by `npm run build`.

For a change, include a short description of the behavior it fixes and the relevant
validation. Keep independent acceptance checks separate from application-generated
expectations. Label simulated, testnet and Solo results accurately.

```sh
npm test
# If browser behavior changes:
npx playwright install --with-deps chromium
npm run test:browser
```

Keep generated reports, logs, screenshots and recordings under `.harness/runs/`.
Commit only minimal fixtures needed to reproduce regressions. Examples and scenario
configuration are source, so their JSON/YAML files should remain tracked.

Do not commit wallet keys, customer capabilities, recovery journals, environment
files or machine-specific account inventories. Review staged files before pushing.
See [security guidance](SECURITY.md) and [technical references](docs/reference/README.md).

Hedera Lab builds on Hedera Harness. Preserve upstream attribution and the MIT
license when changing or redistributing the project.
