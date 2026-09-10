# Container deployment

Start with the local [quick start](../../docs/quickstart.md). The container files
are reference configuration for an operator-managed, single-host deployment.
They are not an installer for an arbitrary cloud account.

## Components

- `Dockerfile`: pinned Node base, application build and browser dependencies.
- `build-context.sh`: creates a source allowlist without local runs or credentials.
- `run-private.sh`: API container, durable store, loopback port and optional worker socket.
- `run-worker.sh`: funded testnet execution worker with no published TCP port.
- `instance-*`: example rootless Docker/systemd/egress configuration. Review and
  adapt host users, UID, paths and firewall interfaces before installation.

The launch scripts invoke `instance-docker`, which expects the dedicated rootless
Docker user/socket. They will not automatically configure that host infrastructure.
Do not run them against an unrelated Docker installation without reviewing them.

## Secrets and registration

Supply your own provider receiving account, execution account and authorization
secrets. Required launcher variables are validated at startup:

| API | Worker |
| --- | --- |
| `VERIFIER_PAY_TO` | `HEDERA_WORKER_OPERATOR_ID` |
| `HEDERA_ADMIN_SECRET_FILE` | `HEDERA_WORKER_KEY_FILE` |
| `HEDERA_WORKER_TOKEN_FILE` for remote execution | `HEDERA_WORKER_TOKEN_FILE` |

The buyer's payment key stays on the client. Mount the execution key only in the
worker, never in the API. Keep secret files outside the checkout with restricted
parent-directory access. Do not log their contents.

Register reviewed scenarios and immutable application artifacts in the API and
worker catalogs. `examples/verification/worker-catalog.json` illustrates a shared
worker serving multiple registered packages; `examples/grant-flow/catalog.json`
is a smaller API catalog for the grant application. Never run independent workers
against the same execution account and separate reservation ledgers.

Use explicit image tags and the launcher overrides for names, catalogs, ports and
volumes. The API binds to host loopback; use an SSH tunnel for private access:

```sh
ssh -N -L 4318:127.0.0.1:4318 user@your-host
```

Public access needs a separately configured HTTPS endpoint and access review.
The project does not ship a public endpoint or a multi-tenant hosting platform.

## Execution and recovery

The API verifies the payment proof and reserves funded worker capacity before
settlement. Only settled work is dispatched. The worker serializes execution,
persists job state, checks independent assertions and reconciles actual fees and
fixture cleanup. Repeated requests reuse completed evidence.

The API and worker have separate networks, processes and data volumes. The worker
socket is authenticated and mode 0600; the API mounts its socket volume read-only.
Containers use resource limits, a read-only root filesystem, dropped capabilities
and no-new-privileges. These controls are not arbitrary uploaded-code isolation.

Before updating artifacts, drain work and resolve reserved, running or interrupted
jobs. Retain previous state and use a fresh build-specific worker volume when
artifact identity changes. Never delete journals or ownership locks to bypass
recovery. In-flight worker crashes can require operator recovery; completed results
are durable. See [transaction recovery](../../docs/lab/RECOVERY.md).
