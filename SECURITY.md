# Security and trust boundaries

Hedera Lab is developer tooling. Local onboarding imports trusted application code
on your machine; filtering its environment is not a filesystem or network sandbox.
Hosted workers execute provider-registered scenarios and bounded transaction plans,
not arbitrary uploaded repositories.

Keep payer, provider execution and customer authorization credentials separate.
The buyer signs locally; the hosted execution key belongs only in the worker.
Use secret-file mounts and disposable test accounts. Never commit private keys,
capabilities, environment files or recovery journals, even for testnet.

The reference deployment binds privately to loopback. Public hosting needs TLS and
an explicit review of access controls, limits and operational recovery. Configuration
checks and tests are not a penetration test or a production security certification.

For a suspected vulnerability, use GitHub private vulnerability reporting if it is
available on the repository. Otherwise contact the maintainer privately through an
existing channel. Do not put credentials or exploitable details in a public issue.
