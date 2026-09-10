#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Whitelist build inputs; never send the Git repo,
# user auth, local reports, operator keys, or other projects to the daemon.
tar --exclude='.harness' --exclude='node_modules' --exclude='.env*' \
  --exclude='lab-recovery.json*' --exclude='customer-token' \
  --exclude='state.json*' --exclude='*.key' --exclude='*.pem' \
  -cf - package.json package-lock.json tsconfig.json src examples prompts \
  skills-index.json deploy/verification/Dockerfile
