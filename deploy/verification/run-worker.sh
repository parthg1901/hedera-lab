#!/usr/bin/env bash
set -euo pipefail
: "${HEDERA_WORKER_OPERATOR_ID:?Set the dedicated funded testnet account}"
: "${HEDERA_WORKER_KEY_FILE:?Set the host signing-key file path}"
: "${HEDERA_WORKER_TOKEN_FILE:?Set the host worker authentication file path}"
[[ "$HEDERA_WORKER_OPERATOR_ID" =~ ^0\.0\.[0-9]+$ ]] || exit 1
runner="$(dirname "$0")/instance-docker"
image="${HEDERA_BACKEND_IMAGE:-hedera-lab/backend:worker-v3}"
container="${HEDERA_WORKER_CONTAINER:-hedera-lab-testnet-worker}"
data_volume="${HEDERA_WORKER_DATA_VOLUME:-hedera-lab-testnet-worker-data}"
socket_volume="${HEDERA_WORKER_SOCKET_VOLUME:-hedera-lab-worker-socket}"
config="${HEDERA_WORKER_CONFIG:-examples/verification/service-catalog.json}"
for value in "$container" "$data_volume" "$socket_volume"; do
  [[ "$value" =~ ^hedera-lab-[a-z0-9-]+$ ]] || { echo 'Invalid project resource name'; exit 1; }
done
"$runner" network inspect hedera-lab-worker >/dev/null 2>&1 || "$runner" network create --label project=hedera-lab hedera-lab-worker
for volume in "$data_volume" "$socket_volume"; do
  "$runner" volume inspect "$volume" >/dev/null 2>&1 || "$runner" volume create --label project=hedera-lab "$volume"
done
"$runner" run -d --name "$container" --label project=hedera-lab \
  --restart unless-stopped --init --stop-timeout 120 --network hedera-lab-worker \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 --ulimit nofile=4096:4096 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --tmpfs /home/node:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  --mount type=volume,source="$data_volume",target=/data \
  --mount type=volume,source="$socket_volume",target=/worker-socket \
  --mount "type=bind,source=$HEDERA_WORKER_KEY_FILE,target=/run/secrets/testnet-operator,readonly" \
  --mount "type=bind,source=$HEDERA_WORKER_TOKEN_FILE,target=/run/secrets/worker-token,readonly" \
  --env "HEDERA_OPERATOR_ID=$HEDERA_WORKER_OPERATOR_ID" \
  --env HEDERA_OPERATOR_KEY_FILE=/run/secrets/testnet-operator \
  --env VERIFIER_WORKER_TOKEN_FILE=/run/secrets/worker-token \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  --health-cmd 'node --input-type=module -e "import {readFile} from \"node:fs/promises\";import {workerRequest} from \"/app/dist/verification/worker.js\";const r=await workerRequest(\"/worker-socket/worker.sock\",(await readFile(\"/run/secrets/worker-token\",\"utf8\")).trim(),\"/health\");if(!r.ok)process.exit(1)"' \
  "$image" node dist/index.js verify worker --config "$config" --store /data --socket /worker-socket/worker.sock
