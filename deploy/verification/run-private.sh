#!/usr/bin/env bash
set -euo pipefail
: "${VERIFIER_PAY_TO:?Set the dedicated testnet receiver account ID}"
: "${HEDERA_ADMIN_SECRET_FILE:?Set the host path to the admin token file}"
[[ "$VERIFIER_PAY_TO" =~ ^0\.0\.[0-9]+$ ]] || { echo 'Invalid receiver account'; exit 1; }
runner="$(dirname "$0")/instance-docker"
volume="${HEDERA_BACKEND_VOLUME:-hedera-lab-contracts-v2-data}"
[[ "$volume" =~ ^hedera-lab-[a-z0-9-]+$ ]] || { echo "Invalid project volume name"; exit 1; }
image="${HEDERA_BACKEND_IMAGE:-hedera-lab/backend:worker-v3}"
container="${HEDERA_BACKEND_CONTAINER:-hedera-lab-backend}"
port="${HEDERA_BACKEND_PORT:-4318}"
socket_volume="${HEDERA_WORKER_SOCKET_VOLUME:-hedera-lab-worker-socket}"
config="${HEDERA_BACKEND_CONFIG:-examples/verification/service-catalog.json}"
for value in "$container" "$socket_volume"; do
  [[ "$value" =~ ^hedera-lab-[a-z0-9-]+$ ]] || { echo 'Invalid project resource name'; exit 1; }
done
[[ "$port" =~ ^[0-9]{4,5}$ ]] && ((10#$port >= 1024 && 10#$port <= 65535)) || { echo 'Invalid private port'; exit 1; }
"$runner" network inspect hedera-lab-private >/dev/null 2>&1 || \
  "$runner" network create --label project=hedera-lab hedera-lab-private
"$runner" volume inspect "$volume" >/dev/null 2>&1 || \
  "$runner" volume create --label project=hedera-lab "$volume"
worker_args=()
if [[ -n "${HEDERA_WORKER_TOKEN_FILE:-}" ]]; then
  worker_args+=(--mount type=volume,source="$socket_volume",target=/worker-socket,readonly)
  worker_args+=(--mount "type=bind,source=$HEDERA_WORKER_TOKEN_FILE,target=/run/secrets/worker-token,readonly")
  worker_args+=(--env VERIFIER_WORKER_SOCKET=/worker-socket/worker.sock --env VERIFIER_WORKER_TOKEN_FILE=/run/secrets/worker-token)
fi
"$runner" run "${worker_args[@]}" -d --name "$container" --label project=hedera-lab \
  --restart unless-stopped --init --stop-timeout 120 \
  --network hedera-lab-private --publish "127.0.0.1:$port:4318" \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --memory 2g --memory-swap 2g --cpus 1 --pids-limit 256 \
  --ulimit nofile=4096:4096 --shm-size 256m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 \
  --tmpfs /home/node:rw,noexec,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700 \
  --mount "type=volume,source=$volume,target=/data" \
  --mount "type=bind,source=$HEDERA_ADMIN_SECRET_FILE,target=/run/secrets/verifier-admin,readonly" \
  --env VERIFIER_ADMIN_TOKEN_FILE=/run/secrets/verifier-admin \
  --env "VERIFIER_PAY_TO=$VERIFIER_PAY_TO" \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  "$image" node dist/index.js verify serve --config "$config" --host 0.0.0.0 --port 4318 --store /data --mode testnet
